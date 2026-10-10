using System.Security.Cryptography;
using Iskra.Server.Crypto;
using Iskra.Server.Storage;

namespace Iskra.Server.Files;

public sealed partial class Uploads
{
    /// <summary>
    /// Stores a file that comes from the server itself (an import), the same way an upload is stored: content-addressed,
    /// typed by its first bytes. Null if it's empty or bigger than <paramref name="maxBytes"/>.
    /// </summary>
    public StoredFile? StoreLocal(Stream source, string name, string uploader, long maxBytes)
    {
        var temp = Path.Combine(world.Path, "uploads", $".incoming-{Guid.NewGuid():N}");
        try
        {
            long size = 0;
            var head = new byte[64 * 1024];
            var headLength = 0;
            using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using (var output = File.Create(temp))
            {
                var buffer = new byte[81920];
                int read;
                while ((read = source.Read(buffer)) > 0)
                {
                    size += read;
                    if (size > maxBytes) return null;
                    if (headLength < head.Length)
                    {
                        var take = Math.Min(read, head.Length - headLength);
                        buffer.AsSpan(0, take).CopyTo(head.AsSpan(headLength));
                        headLength += take;
                    }
                    sha.AppendData(buffer, 0, read);
                    output.Write(buffer, 0, read);
                }
            }
            if (size == 0) return null;
            var hash = Convert.ToHexStringLower(sha.GetHashAndReset());
            var kind = FileSniffer.Sniff(head.AsSpan(0, headLength));
            if (kind.Type == "image/jpeg" && kind.Width is null)
            {
                using var whole = File.OpenRead(temp);
                var (width, height) = FileSniffer.JpegSize(whole);
                kind = kind with { Width = width, Height = height };
            }
            var file = new StoredFile(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)), hash, FileSniffer.CleanName(name), size, kind.Type,
                kind.Width, kind.Height, uploader, time.GetUtcNow().ToUnixTimeMilliseconds());
            var target = PathFor(hash);
            lock (_diskLock)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                if (File.Exists(target)) File.Delete(temp);
                else File.Move(temp, target);
                world.Store.AddFile(file);
            }
            return file;
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }
}
