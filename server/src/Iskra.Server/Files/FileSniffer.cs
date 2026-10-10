using System.Buffers.Binary;

namespace Iskra.Server.Files;

/// <summary>
/// Decides what a file really is from its first bytes (never from its name or the uploader's claim).
/// Only these types are ever shown inline; everything else is served as a download.
/// </summary>
public static class FileSniffer
{
    public sealed record Kind(string Type, bool Inline, int? Width = null, int? Height = null);

    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    private static readonly byte[] Jpeg = [0xFF, 0xD8, 0xFF];
    private static readonly byte[] Webm = [0x1A, 0x45, 0xDF, 0xA3];

    public static Kind Sniff(ReadOnlySpan<byte> head)
    {
        if (head.StartsWith(Png) && head.Length >= 24)
            return new("image/png", true, (int)BinaryPrimitives.ReadUInt32BigEndian(head[16..]), (int)BinaryPrimitives.ReadUInt32BigEndian(head[20..]));
        if (head.StartsWith("GIF87a"u8) || head.StartsWith("GIF89a"u8))
            return head.Length >= 10
                ? new("image/gif", true, BinaryPrimitives.ReadUInt16LittleEndian(head[6..]), BinaryPrimitives.ReadUInt16LittleEndian(head[8..]))
                : new("image/gif", true);
        if (head.Length >= 12 && head.StartsWith("RIFF"u8) && head[8..12].SequenceEqual("WEBP"u8))
        {
            var (w, h) = WebpSize(head);
            return new("image/webp", true, w, h);
        }
        if (head.Length >= 12 && head.StartsWith("RIFF"u8) && head[8..12].SequenceEqual("WAVE"u8))
            return new("audio/wav", true);
        if (head.StartsWith(Jpeg))
        {
            var (w, h) = JpegSize(head);
            return new("image/jpeg", true, w, h);
        }
        if (head.Length >= 12 && head[4..8].SequenceEqual("ftyp"u8))
            return new("video/mp4", true);
        if (head.StartsWith(Webm))
            return new("video/webm", true);
        if (head.StartsWith("OggS"u8))
            return new("audio/ogg", true);
        if (head.StartsWith("ID3"u8) || (head.Length >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0))
            return new("audio/mpeg", true);
        return new("application/octet-stream", false);
    }

    /// <summary>Walks JPEG segments to the start-of-frame marker, which holds the dimensions.</summary>
    private static (int?, int?) JpegSize(ReadOnlySpan<byte> data)
    {
        var i = 2;
        while (i + 9 < data.Length)
        {
            if (data[i] != 0xFF) return (null, null);
            var marker = data[i + 1];
            var length = BinaryPrimitives.ReadUInt16BigEndian(data[(i + 2)..]);
            var isFrame = marker is >= 0xC0 and <= 0xCF and not 0xC4 and not 0xC8 and not 0xCC;
            if (isFrame)
                return (BinaryPrimitives.ReadUInt16BigEndian(data[(i + 7)..]), BinaryPrimitives.ReadUInt16BigEndian(data[(i + 5)..]));
            i += 2 + length;
        }
        return (null, null);
    }

    /// <summary>
    /// The same walk over a whole file, for JPEGs whose start-of-frame lies past the bytes <see cref="Sniff"/> saw
    /// (big EXIF or colour profiles come first). Seeks over segments; stops at the image data.
    /// </summary>
    public static (int?, int?) JpegSize(Stream stream)
    {
        Span<byte> buffer = stackalloc byte[9];
        stream.Position = 2;
        for (var segments = 0; segments < 1000; segments++)
        {
            if (stream.ReadAtLeast(buffer[..4], 4, throwOnEndOfStream: false) < 4 || buffer[0] != 0xFF) return (null, null);
            var marker = buffer[1];
            if (marker is 0xD9 or 0xDA) return (null, null); // end of image, or start of scan: no frame header before it
            var length = BinaryPrimitives.ReadUInt16BigEndian(buffer[2..]);
            if (length < 2) return (null, null);
            if (marker is >= 0xC0 and <= 0xCF and not 0xC4 and not 0xC8 and not 0xCC)
            {
                if (stream.ReadAtLeast(buffer[..5], 5, throwOnEndOfStream: false) < 5) return (null, null);
                return (BinaryPrimitives.ReadUInt16BigEndian(buffer[3..]), BinaryPrimitives.ReadUInt16BigEndian(buffer[1..]));
            }
            stream.Seek(length - 2, SeekOrigin.Current);
        }
        return (null, null);
    }

    /// <summary>The canvas size from the first WebP chunk (VP8X, lossy VP8 or lossless VP8L).</summary>
    private static (int?, int?) WebpSize(ReadOnlySpan<byte> data)
    {
        if (data.Length < 30) return (null, null);
        var chunk = data[12..16];
        if (chunk.SequenceEqual("VP8X"u8))
            return (1 + (data[24] | data[25] << 8 | data[26] << 16), 1 + (data[27] | data[28] << 8 | data[29] << 16));
        if (chunk.SequenceEqual("VP8 "u8) && data[23] == 0x9D && data[24] == 0x01 && data[25] == 0x2A)
            return (BinaryPrimitives.ReadUInt16LittleEndian(data[26..]) & 0x3FFF, BinaryPrimitives.ReadUInt16LittleEndian(data[28..]) & 0x3FFF);
        if (chunk.SequenceEqual("VP8L"u8) && data[20] == 0x2F)
        {
            var bits = BinaryPrimitives.ReadUInt32LittleEndian(data[21..]);
            return ((int)(bits & 0x3FFF) + 1, (int)((bits >> 14) & 0x3FFF) + 1);
        }
        return (null, null);
    }

    /// <summary>A file name that is safe to show and to put in a URL path and a Content-Disposition header.</summary>
    public static string CleanName(string? name)
    {
        var raw = Path.GetFileName((name ?? "").Replace('\\', '/'));
        var cleaned = new string(raw.Where(c => !char.IsControl(c) && c is not ('"' or '/' or '\\' or ':' or '*' or '?' or '<' or '>' or '|')).ToArray()).Trim(' ', '.');
        if (cleaned.Length == 0) cleaned = "file";
        return cleaned.Length > 120 ? cleaned[..60] + "…" + cleaned[^59..] : cleaned;
    }
}
