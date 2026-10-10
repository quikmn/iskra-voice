using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;

namespace Iskra.Server.Backups;

/// <summary>What an encrypted backup says about itself (readable without the passphrase, authenticated with it).</summary>
public sealed record BackupHeader
{
    public int V { get; init; } = 1;
    public string Kdf { get; init; } = "argon2id13";
    public string Salt { get; init; } = "";
    public long Ops { get; init; }
    public long Mem { get; init; }
    public long CreatedAt { get; init; }
    public string ServerKey { get; init; } = "";
    public string Name { get; init; } = "";
}

/// <summary>
/// An encrypted backup (.iskrabackup): "ISKRABK1", u32be header length, header JSON, the 24-byte secretstream header,
/// then chunks of u32be length + crypto_secretstream_xchacha20poly1305 ciphertext (≤ 64 KB plaintext each).
/// The key is Argon2id(passphrase, salt). The first chunk authenticates the magic and header JSON, the last one
/// carries TAG_FINAL, so a changed header, a reordered or cut-off file, or a wrong passphrase is always detected.
/// The plaintext is a zip (see <see cref="BackupArchive"/>).
/// </summary>
public static class BackupFile
{
    public static readonly byte[] Magic = "ISKRABK1"u8.ToArray();
    public const string Extension = ".iskrabackup";
    public const int ChunkSize = 64 * 1024;
    private const int MaxHeaderBytes = 4096;
    public const int MinPassphrase = 8;
    public const int MaxPassphrase = 1024;

    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    /// <summary>The same text gives the same key on every OS and keyboard.</summary>
    public static byte[] PassphraseBytes(string passphrase) => Encoding.UTF8.GetBytes(passphrase.Normalize(NormalizationForm.FormC));

    public static bool LooksEncrypted(ReadOnlySpan<byte> head) => head.StartsWith(Magic);

    /// <summary>Starts an encrypted backup on <paramref name="output"/>. Dispose the returned stream to finish it.</summary>
    public static Stream Encrypt(Stream output, string passphrase, string serverKey, string name, long createdAt,
        long ops = Sodium.OpsModerate, long mem = Sodium.MemModerate)
    {
        var salt = RandomNumberGenerator.GetBytes(Sodium.SaltBytes);
        var header = new BackupHeader
        {
            Salt = Ed25519.ToB64u(salt), Ops = ops, Mem = mem, CreatedAt = createdAt, ServerKey = serverKey, Name = name,
        };
        var headerJson = JsonSerializer.SerializeToUtf8Bytes(header, Json);
        var key = Sodium.DeriveKey(PassphraseBytes(passphrase), salt, ops, mem);
        var streamHeader = new byte[Sodium.HeaderBytes];
        var state = Sodium.SecretStream.ForPush(key, streamHeader);
        CryptographicOperations.ZeroMemory(key);

        output.Write(Magic);
        Span<byte> length = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(length, (uint)headerJson.Length);
        output.Write(length);
        output.Write(headerJson);
        output.Write(streamHeader);
        return new EncryptingStream(output, state, [.. Magic, .. headerJson]);
    }

    /// <summary>Reads the header without the passphrase (to show what a backup is before asking for it).</summary>
    public static BackupHeader ReadHeader(Stream input) => ReadHeader(input, out _);

    private static BackupHeader ReadHeader(Stream input, out byte[] json)
    {
        Span<byte> magic = stackalloc byte[8];
        if (input.ReadAtLeast(magic, 8, throwOnEndOfStream: false) < 8 || !magic.SequenceEqual(Magic))
            throw new InvalidDataException("This isn't an Iskra backup.");
        Span<byte> length = stackalloc byte[4];
        if (input.ReadAtLeast(length, 4, throwOnEndOfStream: false) < 4) throw new InvalidDataException("The backup is damaged.");
        var size = BinaryPrimitives.ReadUInt32BigEndian(length);
        if (size is 0 or > MaxHeaderBytes) throw new InvalidDataException("The backup is damaged.");
        json = new byte[size];
        if (input.ReadAtLeast(json, json.Length, throwOnEndOfStream: false) < json.Length) throw new InvalidDataException("The backup is damaged.");
        BackupHeader? header;
        try { header = JsonSerializer.Deserialize<BackupHeader>(json, Json); }
        catch (JsonException) { throw new InvalidDataException("The backup is damaged."); }
        if (header is null || header.V != 1 || header.Kdf != "argon2id13") throw new InvalidDataException("This backup was made by a newer Iskra. Update iskra-server.");
        // Bounds, so a crafted header can't make us burn minutes of CPU or gigabytes of memory.
        if (header.Ops is < 1 or > 10 || header.Mem is < 8L * 1024 * 1024 or > 1024L * 1024 * 1024)
            throw new InvalidDataException("The backup is damaged.");
        return header;
    }

    /// <summary>
    /// Opens an encrypted backup for reading. Throws <see cref="CryptographicException"/> for a wrong passphrase
    /// (checked right away, on the first chunk) and <see cref="InvalidDataException"/> for a damaged file.
    /// </summary>
    public static (BackupHeader Header, Stream Plain) Decrypt(Stream input, string passphrase)
    {
        var header = ReadHeader(input, out var headerJson);
        var streamHeader = new byte[Sodium.HeaderBytes];
        if (input.ReadAtLeast(streamHeader, streamHeader.Length, throwOnEndOfStream: false) < streamHeader.Length)
            throw new InvalidDataException("The backup is damaged.");
        if (!Ed25519.TryFromB64u(header.Salt, out var salt) || salt.Length != Sodium.SaltBytes) throw new InvalidDataException("The backup is damaged.");
        var key = Sodium.DeriveKey(PassphraseBytes(passphrase), salt, header.Ops, header.Mem);
        var state = Sodium.SecretStream.ForPull(key, streamHeader);
        CryptographicOperations.ZeroMemory(key);
        var plain = new DecryptingStream(input, state, [.. Magic, .. headerJson]);
        plain.Prime();
        return (header, plain);
    }

    private sealed class EncryptingStream(Stream output, Sodium.SecretStream state, byte[] firstAd) : Stream
    {
        private readonly byte[] _buffer = new byte[ChunkSize];
        private int _length;
        private byte[]? _ad = firstAd;
        private bool _done;

        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));

        public override void Write(ReadOnlySpan<byte> data)
        {
            ObjectDisposedException.ThrowIf(_done, this);
            while (data.Length > 0)
            {
                var take = Math.Min(data.Length, _buffer.Length - _length);
                data[..take].CopyTo(_buffer.AsSpan(_length));
                _length += take;
                data = data[take..];
                if (_length == _buffer.Length) Emit(Sodium.TagMessage);
            }
        }

        private void Emit(byte tag)
        {
            var chunk = state.Seal(_buffer, _length, _ad ?? [], tag);
            _ad = null;
            Span<byte> length = stackalloc byte[4];
            BinaryPrimitives.WriteUInt32BigEndian(length, (uint)chunk.Length);
            output.Write(length);
            output.Write(chunk);
            _length = 0;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && !_done)
            {
                Emit(Sodium.TagFinal);
                _done = true;
                output.Flush();
            }
            base.Dispose(disposing);
        }

        public override void Flush() { }
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => !_done;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }

    private sealed class DecryptingStream(Stream input, Sodium.SecretStream state, byte[] firstAd) : Stream
    {
        private byte[] _plain = [];
        private int _offset;
        private byte[]? _ad = firstAd;
        private bool _final;

        /// <summary>Opens the first chunk now, so a wrong passphrase shows up before anything is written.</summary>
        public void Prime() => Next();

        private void Next()
        {
            Span<byte> length = stackalloc byte[4];
            var got = input.ReadAtLeast(length, 4, throwOnEndOfStream: false);
            if (got == 0) throw new InvalidDataException("The backup is incomplete (the file was cut off).");
            if (got < 4) throw new InvalidDataException("The backup is damaged.");
            var size = BinaryPrimitives.ReadUInt32BigEndian(length);
            if (size < Sodium.ABytes || size > ChunkSize + Sodium.ABytes) throw new InvalidDataException("The backup is damaged.");
            var chunk = new byte[size];
            if (input.ReadAtLeast(chunk, chunk.Length, throwOnEndOfStream: false) < chunk.Length)
                throw new InvalidDataException("The backup is incomplete (the file was cut off).");
            var first = _ad is not null;
            var plain = state.Open(chunk, _ad ?? [], out var tag);
            _ad = null;
            if (plain is null)
            {
                if (first) throw new CryptographicException("Wrong passphrase, or this backup was changed.");
                throw new InvalidDataException("The backup is damaged.");
            }
            _plain = plain;
            _offset = 0;
            if (tag == Sodium.TagFinal)
            {
                _final = true;
                Span<byte> extra = stackalloc byte[1];
                if (input.Read(extra) != 0) throw new InvalidDataException("The backup is damaged (data after its end).");
            }
        }

        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

        public override int Read(Span<byte> buffer)
        {
            while (_offset == _plain.Length)
            {
                if (_final) return 0;
                Next();
            }
            var take = Math.Min(buffer.Length, _plain.Length - _offset);
            _plain.AsSpan(_offset, take).CopyTo(buffer);
            _offset += take;
            return take;
        }

        public override void Flush() { }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
