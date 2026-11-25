using System.Buffers.Binary;
using System.Text;

namespace Iskra.Server.Files;

/// <summary>
/// Cleans a HEIC or AVIF picture for a photos channel by changing bytes in place: the file keeps its length and the
/// coded picture is not touched. A HEIF file is a list of items: the picture (often tiles in a grid, a thumbnail and
/// helper pictures), an Exif item, often an XMP item, sometimes more. An allowlist: picture items stay as they are; the
/// Exif item is overwritten with a minimal block (which way up it is and, when the uploader keeps it, the date taken, as
/// in <see cref="PhotoMetadata"/>); every other item (XMP and anything unknown) is overwritten with zeros; <c>udta</c>
/// and <c>uuid</c> boxes become <c>free</c> boxes of zeros. Picture sequences are refused. The app does the same before
/// uploading (client/src/core/heifMetadata.ts) and writes the same bytes.
/// </summary>
public static class HeifMetadata
{
    public const int MaxMetaBytes = 16 * 1024 * 1024;
    private const int MaxItemBytes = 8 * 1024 * 1024;

    private static readonly HashSet<string> PictureItems = ["hvc1", "hev1", "av01", "avc1", "vvc1", "jpeg", "grid", "iovl", "iden", "tmap"];
    private static readonly HashSet<string> FreedBoxes = ["udta", "uuid"];
    private static readonly byte[] ExifPrefix = [0, 0, 0, 6, 0x45, 0x78, 0x69, 0x66, 0, 0];
    private static readonly byte[] EmptyTiff = [0x4D, 0x4D, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0];
    private static readonly string[] HeicBrands = ["heic", "heix", "heim", "heis", "hevc", "hevx"];
    private static readonly string[] AvifBrands = ["avif", "avis"];
    private static readonly string[] GenericBrands = ["mif1", "msf1", "miaf"];

    /// <summary>"image/heic" or "image/avif" if these first bytes are a HEIF picture, else null.</summary>
    public static string? TypeOf(ReadOnlySpan<byte> head)
    {
        if (head.Length < 12 || !head[4..8].SequenceEqual("ftyp"u8)) return null;
        var major = Encoding.Latin1.GetString(head[8..12]);
        if (AvifBrands.Contains(major)) return "image/avif";
        if (HeicBrands.Contains(major)) return "image/heic";
        if (!GenericBrands.Contains(major)) return null;
        var end = (int)Math.Min(head.Length, BinaryPrimitives.ReadUInt32BigEndian(head));
        var found = "image/heic";
        for (var at = 16; at + 4 <= end; at += 4)
            if (AvifBrands.Contains(Encoding.Latin1.GetString(head.Slice(at, 4)))) found = "image/avif";
        return found;
    }

    public static bool IsHeif(string type) => type is "image/heic" or "image/avif";

    private static Mp4Metadata.Refused Damaged() => new("The picture is damaged.");

    private readonly record struct Box(int Start, int Size, int Header, string Type);

    private static List<Box> Children(byte[] b, int from, int to)
    {
        var list = new List<Box>();
        var at = from;
        while (at + 8 <= to)
        {
            long size = BinaryPrimitives.ReadUInt32BigEndian(b.AsSpan(at));
            var header = 8;
            if (size == 1)
            {
                if (at + 16 > to) break;
                size = (long)BinaryPrimitives.ReadUInt64BigEndian(b.AsSpan(at + 8));
                header = 16;
            }
            else if (size == 0) size = to - at;
            if (size < header || at + size > to) break;
            list.Add(new Box(at, (int)size, header, Encoding.Latin1.GetString(b, at + 4, 4)));
            at += (int)size;
        }
        return list;
    }

    private static uint U32(byte[] b, int at) => BinaryPrimitives.ReadUInt32BigEndian(b.AsSpan(at));
    private static int U16(byte[] b, int at) => BinaryPrimitives.ReadUInt16BigEndian(b.AsSpan(at));

    private static long Sized(byte[] b, int at, int size) => size switch
    {
        0 => 0,
        4 => U32(b, at),
        8 => (long)BinaryPrimitives.ReadUInt64BigEndian(b.AsSpan(at)),
        _ => throw Damaged(),
    };

    private static Dictionary<long, string> ItemTypes(byte[] meta, Box iinf)
    {
        var types = new Dictionary<long, string>();
        var p = iinf.Start + iinf.Header;
        var first = p + 4 + (meta[p] == 0 ? 2 : 4);
        foreach (var infe in Children(meta, first, iinf.Start + iinf.Size))
        {
            if (infe.Type != "infe") continue;
            var q = infe.Start + infe.Header;
            var v = meta[q];
            if (v < 2) throw new Mp4Metadata.Refused("This picture's format is too old to clean.");
            long id = v == 2 ? U16(meta, q + 4) : U32(meta, q + 4);
            var at = q + 4 + (v == 2 ? 2 : 4) + 2;
            if (at + 4 > infe.Start + infe.Size) throw Damaged();
            types[id] = Encoding.Latin1.GetString(meta, at, 4);
        }
        return types;
    }

    private static List<(long Id, List<(long Offset, long Length)> Extents)> ItemExtents(byte[] meta, Box iloc, long metaOffset, Box? idat)
    {
        var items = new List<(long, List<(long, long)>)>();
        var end = iloc.Start + iloc.Size;
        var p = iloc.Start + iloc.Header;
        var version = meta[p];
        if (version > 2 || p + 8 > end) throw Damaged();
        var offsetSize = meta[p + 4] >> 4;
        var lengthSize = meta[p + 4] & 15;
        var baseSize = meta[p + 5] >> 4;
        var indexSize = version > 0 ? meta[p + 5] & 15 : 0;
        p += 6;
        long count = version < 2 ? U16(meta, p) : U32(meta, p);
        p += version < 2 ? 2 : 4;
        for (long i = 0; i < count; i++)
        {
            if (p + 8 > end) throw Damaged();
            long id = version < 2 ? U16(meta, p) : U32(meta, p);
            p += version < 2 ? 2 : 4;
            var method = 0;
            if (version > 0)
            {
                method = U16(meta, p) & 15;
                p += 2;
            }
            p += 2; // data reference index
            if (p + baseSize + 2 > end) throw Damaged();
            var start = Sized(meta, p, baseSize);
            p += baseSize;
            var extentCount = U16(meta, p);
            p += 2;
            var extents = new List<(long, long)>();
            for (var e = 0; e < extentCount; e++)
            {
                if (p + indexSize + offsetSize + lengthSize > end) throw Damaged();
                p += indexSize;
                var offset = Sized(meta, p, offsetSize);
                p += offsetSize;
                var length = Sized(meta, p, lengthSize);
                p += lengthSize;
                if (method == 0) extents.Add((start + offset, length));
                else if (method == 1 && idat is { } data) extents.Add((metaOffset + data.Start + data.Header + start + offset, length));
                else throw new Mp4Metadata.Refused("This picture stores its parts in a way that can't be cleaned.");
            }
            items.Add((id, extents));
        }
        return items;
    }

    private static byte[] ExifReplacement(int length, PhotoMetadata.Kept kept, bool keepDate)
    {
        var output = new byte[length];
        foreach (var block in new[] { PhotoMetadata.BuildExif(kept, keepDate) ?? EmptyTiff, EmptyTiff })
        {
            if (ExifPrefix.Length + block.Length > length) continue;
            ExifPrefix.CopyTo(output, 0);
            block.CopyTo(output, ExifPrefix.Length);
            break;
        }
        return output;
    }

    private static byte[] Read(Stream file, long offset, long length)
    {
        var bytes = new byte[length];
        file.Position = offset;
        file.ReadExactly(bytes);
        return bytes;
    }

    /// <summary>What to change in the file (empty: it is clean already). Throws <see cref="Mp4Metadata.Refused"/> for files it can't clean.</summary>
    public static List<Mp4Metadata.Patch> Plan(Stream file, bool keepDate)
    {
        var patches = new List<Mp4Metadata.Patch>();
        var kept = PhotoMetadata.Kept.Nothing;
        var length = file.Length;
        var header = new byte[16];
        var hasMeta = false;
        long at = 0;
        while (at + 8 <= length)
        {
            file.Position = at;
            var got = file.ReadAtLeast(header, 16, throwOnEndOfStream: false);
            if (got < 8) break;
            long size = BinaryPrimitives.ReadUInt32BigEndian(header);
            var type = Encoding.Latin1.GetString(header, 4, 4);
            var headerLength = 8;
            if (size == 1)
            {
                if (got < 16) throw Damaged();
                size = (long)BinaryPrimitives.ReadUInt64BigEndian(header.AsSpan(8));
                headerLength = 16;
            }
            else if (size == 0) size = length - at;
            if (size < headerLength || at + size > length)
            {
                if (hasMeta) break;
                throw Damaged();
            }
            if (type is "moov" or "moof") throw new Mp4Metadata.Refused("Picture sequences and animations in this format can't be added.");
            if (type == "meta")
            {
                if (hasMeta) throw Damaged();
                if (size > MaxMetaBytes) throw new Mp4Metadata.Refused("The picture's header is too large to clean.");
                hasMeta = true;
                var original = Read(file, at, size);
                var meta = (byte[])original.Clone();
                var boxes = Children(meta, headerLength + 4, meta.Length); // a full box: version and flags first
                foreach (var box in boxes.Where(b => FreedBoxes.Contains(b.Type)))
                {
                    "free"u8.CopyTo(meta.AsSpan(box.Start + 4));
                    meta.AsSpan(box.Start + box.Header, box.Size - box.Header).Clear();
                }
                var metaStart = at;
                Box? Find(string name) => boxes.Where(b => b.Type == name).Select(b => (Box?)b).FirstOrDefault();
                if (Find("iinf") is not { } iinf || Find("iloc") is not { } iloc) throw Damaged();
                var types = ItemTypes(meta, iinf);
                bool InMeta((long Offset, long Length) e) => e.Offset >= metaStart && e.Offset + e.Length <= metaStart + size;
                foreach (var (id, parts) in ItemExtents(meta, iloc, at, Find("idat")))
                {
                    var itemType = types.GetValueOrDefault(id, "");
                    if (PictureItems.Contains(itemType)) continue;
                    var total = parts.Sum(e => e.Length);
                    if (total == 0) continue;
                    if (parts.Any(e => e.Length == 0 || e.Offset < 0 || e.Offset + e.Length > length)) throw Damaged();
                    if (total > MaxItemBytes)
                    {
                        foreach (var e in parts)
                        {
                            if (InMeta(e)) meta.AsSpan((int)(e.Offset - metaStart), (int)e.Length).Clear();
                            else patches.Add(new Mp4Metadata.Patch(e.Offset, null, e.Length));
                        }
                        continue;
                    }
                    var current = new byte[total];
                    var filled = 0;
                    foreach (var e in parts)
                    {
                        Read(file, e.Offset, e.Length).CopyTo(current, filled);
                        filled += (int)e.Length;
                    }
                    var replacement = new byte[total];
                    if (itemType == "Exif")
                    {
                        // The item starts with the distance from byte 4 to its TIFF block.
                        long skip = total >= 4 ? U32(current, 0) : 0;
                        if (4 + skip < total) kept = PhotoMetadata.ReadExif(current.AsSpan((int)(4 + skip)));
                        replacement = ExifReplacement((int)total, kept, keepDate);
                    }
                    if (current.AsSpan().SequenceEqual(replacement)) continue;
                    var done = 0;
                    foreach (var e in parts)
                    {
                        var piece = replacement.AsSpan(done, (int)e.Length).ToArray();
                        if (InMeta(e)) piece.CopyTo(meta, (int)(e.Offset - metaStart));
                        else patches.Add(new Mp4Metadata.Patch(e.Offset, piece, 0));
                        done += (int)e.Length;
                    }
                }
                if (!meta.AsSpan().SequenceEqual(original)) patches.Add(new Mp4Metadata.Patch(metaStart, meta, 0));
            }
            else if (FreedBoxes.Contains(type))
            {
                var body = size - headerLength;
                var zero = body > 0 && body <= MaxItemBytes && Read(file, at + headerLength, body).All(v => v == 0);
                patches.Add(new Mp4Metadata.Patch(at + 4, "free"u8.ToArray(), 0));
                if (body > 0 && !zero) patches.Add(new Mp4Metadata.Patch(at + headerLength, null, body));
            }
            at += size;
        }
        if (!hasMeta) throw new Mp4Metadata.Refused("The picture has no header.");
        return patches;
    }
}
