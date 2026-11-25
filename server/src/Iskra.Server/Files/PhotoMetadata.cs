using System.Buffers.Binary;
using System.Text;

namespace Iskra.Server.Files;

/// <summary>
/// Cleans a picture for a photos channel without decoding it (the pixels stay exactly the uploader's). On top of
/// <see cref="ImageMetadata"/>'s allowlist, two things from the picture's EXIF block survive in a new, minimal one:
/// which way up it is (so phone photos don't turn on their side) and, when the uploader keeps it, the date and time
/// taken with its time zone offset. Location, camera make, model and serial numbers, lens, software, owner and
/// copyright fields, maker notes, comments, XMP and embedded thumbnails all go. The app does the same before uploading
/// (client/src/core/photoMetadata.ts); both write the same bytes, so a cleaned picture passes through unchanged.
/// </summary>
public static class PhotoMetadata
{
    /// <summary>What is kept from a picture's EXIF block.</summary>
    public sealed record Kept(int Orientation, string? Date, string? Offset)
    {
        public static readonly Kept Nothing = new(1, null, null);
    }

    /// <summary>The types a photos channel takes as pictures.</summary>
    public static bool IsPicture(string type) => type is "image/jpeg" or "image/png" or "image/webp" or "image/gif";

    /// <summary>What a thumbnail or a picture made for display may be: a still picture every app can draw.</summary>
    public static bool IsStill(string type) => type is "image/jpeg" or "image/png" or "image/webp";

    /// <summary>The picture without its metadata (the same bytes if there was nothing to remove).</summary>
    public static byte[] Clean(byte[] data, string type, bool keepDate) => type switch
    {
        "image/jpeg" => Jpeg(data, keepDate),
        "image/png" => ImageMetadata.Strip(data, type),
        "image/webp" => Webp(data, keepDate),
        "image/gif" => Gif(data),
        _ => throw new ImageMetadata.Refused("Not a JPEG, PNG or WebP picture."),
    };

    // ── EXIF ─────────────────────────────────────────────────────────────────

    /// <summary>Reads the orientation and the date taken from a TIFF block (the inside of an EXIF segment). Never throws.</summary>
    public static Kept ReadExif(ReadOnlySpan<byte> tiff)
    {
        if (tiff.Length < 8) return Kept.Nothing;
        bool little;
        if (tiff[0] == (byte)'I' && tiff[1] == (byte)'I') little = true;
        else if (tiff[0] == (byte)'M' && tiff[1] == (byte)'M') little = false;
        else return Kept.Nothing;
        if (U16(tiff, 2, little) != 42) return Kept.Nothing;

        var orientation = 1;
        string? date = null, original = null, digitized = null, offset = null;
        long exifIfd = 0;
        foreach (var (tag, kind, count, at) in Entries(tiff, U32(tiff, 4, little), little))
        {
            if (tag == 0x0112 && kind == 3 && count == 1 && U16(tiff, at, little) is >= 1 and <= 8 and var o) orientation = o;
            else if (tag == 0x0132) date = Ascii(tiff, kind, count, at, little);
            else if (tag == 0x8769 && kind == 4 && count == 1) exifIfd = U32(tiff, at, little);
        }
        if (exifIfd > 0)
        {
            foreach (var (tag, kind, count, at) in Entries(tiff, exifIfd, little))
            {
                if (tag == 0x9003) original = Ascii(tiff, kind, count, at, little);
                else if (tag == 0x9004) digitized = Ascii(tiff, kind, count, at, little);
                else if (tag == 0x9011) offset = Ascii(tiff, kind, count, at, little);
            }
        }
        var taken = new[] { original, digitized, date }.FirstOrDefault(IsDate);
        return new Kept(orientation, taken, taken is not null && IsOffset(offset) ? offset : null);
    }

    private static int U16(ReadOnlySpan<byte> b, int at, bool little) =>
        little ? BinaryPrimitives.ReadUInt16LittleEndian(b[at..]) : BinaryPrimitives.ReadUInt16BigEndian(b[at..]);

    private static long U32(ReadOnlySpan<byte> b, int at, bool little) =>
        little ? BinaryPrimitives.ReadUInt32LittleEndian(b[at..]) : BinaryPrimitives.ReadUInt32BigEndian(b[at..]);

    /// <summary>The entries of one directory: tag, type, count and where its 4 value bytes are.</summary>
    private static List<(int Tag, int Kind, long Count, int At)> Entries(ReadOnlySpan<byte> tiff, long ifd, bool little)
    {
        var list = new List<(int, int, long, int)>();
        if (ifd < 8 || ifd + 2 > tiff.Length) return list;
        var n = U16(tiff, (int)ifd, little);
        for (var i = 0; i < n; i++)
        {
            var at = (int)ifd + 2 + i * 12;
            if (at + 12 > tiff.Length) break;
            list.Add((U16(tiff, at, little), U16(tiff, at + 2, little), U32(tiff, at + 4, little), at + 8));
        }
        return list;
    }

    private static string? Ascii(ReadOnlySpan<byte> tiff, int kind, long count, int at, bool little)
    {
        if (kind != 2 || count is < 1 or > 64) return null;
        var start = count <= 4 ? at : U32(tiff, at, little);
        if (start < 0 || start + count > tiff.Length) return null;
        var bytes = tiff.Slice((int)start, (int)count);
        var end = bytes.IndexOf((byte)0);
        if (end >= 0) bytes = bytes[..end];
        foreach (var b in bytes) if (b is < 0x20 or > 0x7E) return null;
        return Encoding.ASCII.GetString(bytes);
    }

    /// <summary>"2026:07:14 18:30:05".</summary>
    public static bool IsDate(string? s)
    {
        if (s is null || s.Length != 19) return false;
        for (var i = 0; i < 19; i++)
        {
            var c = s[i];
            var ok = i is 4 or 7 or 13 or 16 ? c == ':' : i == 10 ? c == ' ' : c is >= '0' and <= '9';
            if (!ok) return false;
        }
        return s != "0000:00:00 00:00:00";
    }

    /// <summary>"+02:00".</summary>
    public static bool IsOffset(string? s) =>
        s is { Length: 6 } && s[0] is '+' or '-' && s[3] == ':' && char.IsAsciiDigit(s[1]) && char.IsAsciiDigit(s[2]) && char.IsAsciiDigit(s[4]) && char.IsAsciiDigit(s[5]);

    /// <summary>
    /// A TIFF block with only what is kept (big-endian; tags in ascending order), or null when there is nothing to keep:
    /// the picture is upright and has no date (or the date isn't kept).
    /// </summary>
    public static byte[]? BuildExif(Kept kept, bool keepDate)
    {
        var orientation = kept.Orientation is >= 2 and <= 8 ? kept.Orientation : 0;
        var date = keepDate && IsDate(kept.Date) ? kept.Date : null;
        var offset = date is not null && IsOffset(kept.Offset) ? kept.Offset : null;
        if (orientation == 0 && date is null) return null;

        var ifd0Count = (orientation != 0 ? 1 : 0) + (date is not null ? 1 : 0);
        var ifd0Size = 2 + ifd0Count * 12 + 4;
        var exifAt = 8 + ifd0Size;
        var exifCount = date is null ? 0 : offset is null ? 1 : 2;
        var exifSize = date is null ? 0 : 2 + exifCount * 12 + 4;
        var dateAt = exifAt + exifSize;
        var offsetAt = dateAt + 20;
        var total = date is null ? exifAt : offset is null ? dateAt + 20 : offsetAt + 8;

        var b = new byte[total];
        var at = 0;
        void P16(int v) { BinaryPrimitives.WriteUInt16BigEndian(b.AsSpan(at), (ushort)v); at += 2; }
        void P32(long v) { BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(at), (uint)v); at += 4; }
        b[0] = (byte)'M'; b[1] = (byte)'M'; at = 2;
        P16(42); P32(8);
        P16(ifd0Count);
        if (orientation != 0) { P16(0x0112); P16(3); P32(1); P16(orientation); P16(0); }
        if (date is not null) { P16(0x8769); P16(4); P32(1); P32(exifAt); }
        P32(0);
        if (date is not null)
        {
            P16(exifCount);
            P16(0x9003); P16(2); P32(20); P32(dateAt);
            if (offset is not null) { P16(0x9011); P16(2); P32(7); P32(offsetAt); }
            P32(0);
            Encoding.ASCII.GetBytes(date, b.AsSpan(dateAt));
            if (offset is not null) Encoding.ASCII.GetBytes(offset, b.AsSpan(offsetAt));
        }
        return b;
    }

    // ── JPEG ─────────────────────────────────────────────────────────────────

    private static readonly byte[] ExifHeader = "Exif\0\0"u8.ToArray();

    /// <summary>The TIFF block of a JPEG's first EXIF segment, or empty.</summary>
    public static ReadOnlySpan<byte> JpegExif(ReadOnlySpan<byte> data)
    {
        var i = 2;
        while (i + 4 <= data.Length && data[i] == 0xFF)
        {
            var marker = data[i + 1];
            if (marker == 0xFF) { i++; continue; }
            if (marker is 0xDA or 0xD9) break;
            if (marker is (>= 0xD0 and <= 0xD7) or 0x01) { i += 2; continue; }
            var length = BinaryPrimitives.ReadUInt16BigEndian(data[(i + 2)..]);
            if (length < 2 || i + 2 + length > data.Length) break;
            var payload = data.Slice(i + 4, length - 2);
            if (marker == 0xE1 && payload.StartsWith(ExifHeader)) return payload[6..];
            i += 2 + length;
        }
        return default;
    }

    private static byte[] Jpeg(byte[] data, bool keepDate)
    {
        var stripped = ImageMetadata.Strip(data, "image/jpeg"); // checks it is a JPEG; starts with FF D8
        var exif = BuildExif(ReadExif(JpegExif(data)), keepDate);
        if (exif is null) return stripped;
        var output = new byte[stripped.Length + 4 + ExifHeader.Length + exif.Length];
        output[0] = 0xFF; output[1] = 0xD8; output[2] = 0xFF; output[3] = 0xE1;
        BinaryPrimitives.WriteUInt16BigEndian(output.AsSpan(4), (ushort)(2 + ExifHeader.Length + exif.Length));
        ExifHeader.CopyTo(output, 6);
        exif.CopyTo(output, 12);
        stripped.AsSpan(2).CopyTo(output.AsSpan(12 + exif.Length));
        return output;
    }

    // ── GIF ──────────────────────────────────────────────────────────────────

    private static readonly string[] Looping = ["NETSCAPE2.0", "ANIMEXTS1.0"];

    /// <summary>
    /// The GIF with its frames, their timing and its looping, and nothing else: comments, plain text and every
    /// application extension but the looping one (XMP, ICC, tool marks) go. Frames are copied as they are.
    /// </summary>
    private static byte[] Gif(byte[] data)
    {
        if (data.Length < 13 || !(data.AsSpan(0, 6).SequenceEqual("GIF87a"u8) || data.AsSpan(0, 6).SequenceEqual("GIF89a"u8)))
            throw new ImageMetadata.Refused("Not a GIF.");
        static ImageMetadata.Refused Early() => new("The GIF ends early.");
        static int Table(byte flags) => (flags & 0x80) != 0 ? 3 * (1 << ((flags & 7) + 1)) : 0;
        // The end of a run of sub-blocks (each: a length byte, then that many bytes; a zero ends the run).
        int Blocks(int at)
        {
            while (true)
            {
                if (at >= data.Length) throw Early();
                var size = data[at];
                at += 1 + size;
                if (size == 0) return at;
            }
        }
        var i = 13 + Table(data[10]);
        if (i > data.Length) throw Early();
        using var output = new MemoryStream(data.Length);
        output.Write(data, 0, i);
        var frames = 0;
        while (true)
        {
            if (i >= data.Length) throw Early();
            var kind = data[i];
            if (kind == 0x3B) break;
            if (kind == 0x2C)
            {
                if (i + 10 > data.Length) throw Early();
                var end = Blocks(i + 10 + Table(data[i + 9]) + 1);
                if (end > data.Length) throw Early();
                output.Write(data, i, end - i);
                frames++;
                i = end;
            }
            else if (kind == 0x21)
            {
                if (i + 2 > data.Length) throw Early();
                var label = data[i + 1];
                var end = Blocks(i + 2);
                if (end > data.Length) throw Early();
                var keep = label == 0xF9 || (label == 0xFF && data[i + 2] == 11 && i + 14 <= data.Length && Looping.Contains(Encoding.Latin1.GetString(data, i + 3, 11)));
                if (keep) output.Write(data, i, end - i);
                i = end;
            }
            else throw new ImageMetadata.Refused("The GIF is damaged.");
        }
        if (frames == 0) throw new ImageMetadata.Refused("The GIF has no image data.");
        output.WriteByte(0x3B);
        return output.ToArray();
    }

    // ── WebP ─────────────────────────────────────────────────────────────────

    private static byte[] Webp(byte[] data, bool keepDate)
    {
        if (data.Length < 20 || !data.AsSpan(0, 4).SequenceEqual("RIFF"u8) || !data.AsSpan(8, 4).SequenceEqual("WEBP"u8))
            throw new ImageMetadata.Refused("Not a WebP.");
        var riffEnd = 8L + BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(4));
        if (riffEnd > data.Length) throw new ImageMetadata.Refused("The WebP ends early.");
        using var output = new MemoryStream(data.Length);
        output.Write("RIFF\0\0\0\0WEBP"u8); // the size is filled in at the end
        var kept = Kept.Nothing;
        var flagsAt = -1;
        var hasImage = false;
        var i = 12;
        while (i + 8 <= riffEnd)
        {
            var fourcc = Encoding.ASCII.GetString(data, i, 4);
            var size = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(i + 4));
            var padded = 8L + size + (size & 1);
            if (i + 8 + (long)size > riffEnd) throw new ImageMetadata.Refused("A WebP chunk runs past the end.");
            var whole = data.AsSpan(i, (int)Math.Min(padded, riffEnd - i));
            switch (fourcc)
            {
                case "VP8X":
                    if (size < 10) throw new ImageMetadata.Refused("The WebP header is damaged.");
                    flagsAt = (int)output.Position + 8;
                    output.Write(whole);
                    break;
                case "VP8 " or "VP8L" or "ANMF":
                    hasImage = true;
                    output.Write(whole);
                    break;
                case "ALPH" or "ICCP" or "ANIM": // transparency, the colour profile, animation settings
                    output.Write(whole);
                    break;
                case "EXIF":
                    var tiff = data.AsSpan(i + 8, (int)size);
                    kept = ReadExif(tiff.StartsWith(ExifHeader) ? tiff[6..] : tiff);
                    break;
                default: // "XMP " and anything unknown
                    break;
            }
            i += (int)padded;
        }
        if (!hasImage) throw new ImageMetadata.Refused("The WebP has no image data.");
        var exif = flagsAt >= 0 ? BuildExif(kept, keepDate) : null; // only the extended format can carry EXIF
        if (exif is not null)
        {
            Span<byte> header = stackalloc byte[8];
            "EXIF"u8.CopyTo(header);
            BinaryPrimitives.WriteUInt32LittleEndian(header[4..], (uint)exif.Length);
            output.Write(header);
            output.Write(exif);
            if ((exif.Length & 1) == 1) output.WriteByte(0);
        }
        var bytes = output.ToArray();
        if (flagsAt >= 0) bytes[flagsAt] = (byte)((bytes[flagsAt] & ~(0x08 | 0x04)) | (exif is not null ? 0x08 : 0)); // no XMP; EXIF only if we wrote one
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), (uint)(bytes.Length - 8));
        return bytes;
    }
}
