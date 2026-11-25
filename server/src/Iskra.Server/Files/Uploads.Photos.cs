using System.Security.Cryptography;
using Iskra.Server.Crypto;
using Iskra.Server.Storage;

namespace Iskra.Server.Files;

public sealed partial class Uploads
{
    /// <summary>What a stored upload is to a photos channel: "image", "video", or null if it takes neither.</summary>
    public string? PhotoKind(StoredFile file)
    {
        if (PhotoMetadata.IsPicture(file.Type) || HeifMetadata.IsHeif(file.Type)) return "image";
        return file.Type == "video/mp4" ? "video" : null;
    }

    /// <summary>
    /// The upload cleaned for a photos channel (<see cref="PhotoMetadata"/>, <see cref="HeifMetadata"/>, <see cref="Mp4Metadata"/>): the same record
    /// if it was clean already (the app cleans before uploading), else a new one with the cleaned content.
    /// Throws <see cref="ImageMetadata.Refused"/> or <see cref="Mp4Metadata.Refused"/> for files that can't be cleaned.
    /// </summary>
    public StoredFile CleanForPhotos(StoredFile file, bool keepDate)
    {
        var path = PathFor(file.Sha256);
        if (PhotoMetadata.IsPicture(file.Type))
        {
            var bytes = ReadContent(file, MaxBytes) ?? throw new ImageMetadata.Refused("The picture is missing.");
            var cleaned = PhotoMetadata.Clean(bytes, file.Type, keepDate);
            if (cleaned.AsSpan().SequenceEqual(bytes)) return file;
            var kind = FileSniffer.Sniff(cleaned.AsSpan(0, Math.Min(cleaned.Length, 64 * 1024)));
            var (width, height) = (kind.Width, kind.Height);
            if (kind.Type == "image/jpeg" && width is null)
            {
                using var whole = new MemoryStream(cleaned);
                (width, height) = FileSniffer.JpegSize(whole);
            }
            return StoreCopy(file, cleaned, file.Type, width ?? file.Width ?? 0, height ?? file.Height ?? 0);
        }

        List<Mp4Metadata.Patch> patches;
        using (var source = File.OpenRead(path))
            patches = HeifMetadata.IsHeif(file.Type) ? HeifMetadata.Plan(source, keepDate) : Mp4Metadata.Plan(source, keepDate);
        if (patches.Count == 0) return file;
        var temp = NewTemp();
        try
        {
            File.Copy(path, temp);
            string hash;
            using (var copy = new FileStream(temp, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                Mp4Metadata.Apply(copy, patches);
                copy.Flush();
                copy.Position = 0;
                hash = Convert.ToHexStringLower(SHA256.HashData(copy));
            }
            if (hash == file.Sha256) return file;
            var cleaned = new StoredFile(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)), hash, file.Name, file.Size, file.Type,
                file.Width, file.Height, file.Uploader, time.GetUtcNow().ToUnixTimeMilliseconds());
            var target = PathFor(hash);
            lock (_diskLock)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                var moved = false;
                if (!File.Exists(target))
                {
                    File.Move(temp, target);
                    moved = true;
                }
                try { world.Store.AddFile(cleaned); }
                catch when (moved)
                {
                    File.Delete(target);
                    throw;
                }
            }
            return cleaned;
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }
}
