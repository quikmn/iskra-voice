using System.Security.Cryptography;
using Iskra.Server.Crypto;
using Iskra.Server.Storage;

namespace Iskra.Server.Files;

public sealed partial class Uploads
{
    /// <summary>The stored bytes of a file, or null if its content is missing or bigger than <paramref name="maxBytes"/>.</summary>
    public byte[]? ReadContent(StoredFile file, long maxBytes)
    {
        var path = PathFor(file.Sha256);
        try
        {
            if (new FileInfo(path).Length > maxBytes) return null;
            return File.ReadAllBytes(path);
        }
        catch (IOException) { return null; }
    }

    /// <summary>
    /// A cleaned copy of <paramref name="original"/> (same name and uploader, new content), recorded like an upload.
    /// Returns the original itself when the bytes didn't change.
    /// </summary>
    public StoredFile StoreCopy(StoredFile original, byte[] bytes, string type, int width, int height)
    {
        var hash = Convert.ToHexStringLower(SHA256.HashData(bytes));
        if (hash == original.Sha256) return original;
        var file = new StoredFile(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)), hash, original.Name, bytes.Length, type,
            width, height, original.Uploader, time.GetUtcNow().ToUnixTimeMilliseconds());
        var target = PathFor(hash);
        lock (_diskLock)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            var written = false;
            if (!File.Exists(target))
            {
                var temp = NewTemp();
                File.WriteAllBytes(temp, bytes);
                File.Move(temp, target);
                written = true;
            }
            try
            {
                world.Store.AddFile(file);
            }
            catch when (written)
            {
                File.Delete(target);
                throw;
            }
        }
        return file;
    }
}
