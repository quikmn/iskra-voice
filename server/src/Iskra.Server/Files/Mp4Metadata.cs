using System.Buffers.Binary;
using System.Text;

namespace Iskra.Server.Files;

/// <summary>
/// Cleans an MP4 or QuickTime video for a photos channel by changing bytes in place: nothing moves, nothing is
/// re-encoded, the file keeps its length. Inside the movie header, the boxes that carry metadata (<c>udta</c>,
/// <c>meta</c>, <c>uuid</c>: location, make, model, software, XMP) become <c>free</c> boxes filled with zeros; every
/// track that isn't video, audio or a timecode (timed metadata such as GPS tracks, subtitles) is removed the same way
/// and its samples in the file are overwritten with zeros; handler names are blanked. Top-level <c>uuid</c>,
/// <c>meta</c> and <c>udta</c> boxes go too. The creation and modification times stay only when the uploader keeps the
/// date. The app does the same before uploading (client/src/core/mp4Metadata.ts).
/// </summary>
public static class Mp4Metadata
{
    public const int MaxMoovBytes = 64 * 1024 * 1024;

    /// <summary>Bytes to write at <see cref="Offset"/>: <see cref="Data"/>, or <see cref="Zeros"/> zero bytes.</summary>
    public sealed record Patch(long Offset, byte[]? Data, long Zeros);

    public sealed class Refused(string message) : Exception(message);

    private static readonly HashSet<string> KeptHandlers = ["vide", "soun", "tmcd"];
    private static readonly HashSet<string> MetadataBoxes = ["udta", "meta", "uuid"];

    /// <summary>What to change in the file (empty: it is clean already). Throws <see cref="Refused"/> for files it can't clean.</summary>
    public static List<Patch> Plan(Stream file, bool keepDate)
    {
        var patches = new List<Patch>();
        var length = file.Length;
        var header = new byte[16];
        long at = 0;
        var hasMoov = false;
        var fragmented = false;
        var droppedTracks = false;
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
                if (got < 16) throw new Refused("The video is damaged.");
                size = (long)BinaryPrimitives.ReadUInt64BigEndian(header.AsSpan(8));
                headerLength = 16;
            }
            else if (size == 0) size = length - at;
            if (size < headerLength || at + size > length)
            {
                if (hasMoov) break; // junk after the movie: players ignore it
                throw new Refused("The video is damaged.");
            }
            if (type == "moov")
            {
                if (hasMoov) throw new Refused("The video has two movie headers.");
                if (size > MaxMoovBytes) throw new Refused("The video's header is too large to clean.");
                hasMoov = true;
                var original = new byte[size];
                file.Position = at;
                file.ReadExactly(original);
                var moov = (byte[])original.Clone();
                var ranges = CleanMoov(moov, headerLength, keepDate);
                droppedTracks = ranges is not null;
                if (!moov.AsSpan().SequenceEqual(original)) patches.Add(new Patch(at, moov, 0));
                foreach (var (offset, count) in ranges ?? [])
                    if (offset >= 0 && count > 0 && offset + count <= length) patches.Add(new Patch(offset, null, count));
            }
            else if (MetadataBoxes.Contains(type))
            {
                patches.Add(new Patch(at + 4, "free"u8.ToArray(), 0));
                if (size > headerLength) patches.Add(new Patch(at + headerLength, null, size - headerLength));
            }
            else if (type == "moof") fragmented = true;
            at += size;
        }
        if (!hasMoov) throw new Refused("The video has no movie header.");
        if (fragmented && droppedTracks) throw new Refused("This video keeps extra tracks in fragments, which can't be cleaned.");
        return patches;
    }

    /// <summary>Applies <see cref="Plan"/>'s patches to a copy of the file.</summary>
    public static void Apply(Stream file, IEnumerable<Patch> patches)
    {
        var zeros = new byte[64 * 1024];
        foreach (var patch in patches)
        {
            file.Position = patch.Offset;
            if (patch.Data is not null) file.Write(patch.Data);
            for (var left = patch.Zeros; left > 0;)
            {
                var n = (int)Math.Min(left, zeros.Length);
                file.Write(zeros, 0, n);
                left -= n;
            }
        }
    }

    /// <summary>The movie's creation time in Unix milliseconds, or null (for tests and tools).</summary>
    public static long? CreatedAt(byte[] moov, int headerLength)
    {
        foreach (var box in Children(moov, headerLength, moov.Length))
        {
            if (box.Type != "mvhd") continue;
            var p = box.Start + box.Header;
            if (p + 20 > box.Start + box.Size) return null;
            var seconds = moov[p] == 1 ? (long)BinaryPrimitives.ReadUInt64BigEndian(moov.AsSpan(p + 4)) : BinaryPrimitives.ReadUInt32BigEndian(moov.AsSpan(p + 4));
            return seconds == 0 ? null : (seconds - 2082844800L) * 1000;
        }
        return null;
    }

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

    private static Box? Child(byte[] b, Box parent, string type)
    {
        foreach (var box in Children(b, parent.Start + parent.Header, parent.Start + parent.Size))
            if (box.Type == type) return box;
        return null;
    }

    /// <summary>Turns a box into a <c>free</c> box of the same size, filled with zeros.</summary>
    private static void Free(byte[] b, Box box)
    {
        "free"u8.CopyTo(b.AsSpan(box.Start + 4));
        b.AsSpan(box.Start + box.Header, box.Size - box.Header).Clear();
    }

    /// <summary>mvhd, tkhd and mdhd start with a version byte, three flag bytes, then the creation and modification times.</summary>
    private static void ClearDates(byte[] b, Box box)
    {
        var p = box.Start + box.Header;
        var bytes = b[p] == 1 ? 16 : 8;
        if (p + 4 + bytes <= box.Start + box.Size) b.AsSpan(p + 4, bytes).Clear();
    }

    /// <summary>Cleans the movie header in place. Returns the file ranges of removed tracks' samples, or null if no track was removed.</summary>
    private static List<(long Offset, long Count)>? CleanMoov(byte[] moov, int headerLength, bool keepDate)
    {
        List<(long, long)>? ranges = null;
        foreach (var box in Children(moov, headerLength, moov.Length))
        {
            if (box.Type == "mvhd" && !keepDate) ClearDates(moov, box);
            else if (MetadataBoxes.Contains(box.Type)) Free(moov, box);
            else if (box.Type == "trak")
            {
                var mdia = Child(moov, box, "mdia");
                var hdlr = mdia is { } m ? Child(moov, m, "hdlr") : null;
                var handler = hdlr is { } h && h.Size >= h.Header + 12 ? Encoding.Latin1.GetString(moov, h.Start + h.Header + 8, 4) : "";
                if (!KeptHandlers.Contains(handler))
                {
                    ranges ??= [];
                    ranges.AddRange(SampleRanges(moov, mdia));
                    Free(moov, box);
                    continue;
                }
                foreach (var inner in Children(moov, box.Start + box.Header, box.Start + box.Size))
                {
                    if (inner.Type == "tkhd" && !keepDate) ClearDates(moov, inner);
                    else if (MetadataBoxes.Contains(inner.Type)) Free(moov, inner);
                    else if (inner.Type == "mdia")
                    {
                        foreach (var media in Children(moov, inner.Start + inner.Header, inner.Start + inner.Size))
                        {
                            if (media.Type == "mdhd" && !keepDate) ClearDates(moov, media);
                            else if (media.Type == "hdlr" && media.Size > media.Header + 24)
                                moov.AsSpan(media.Start + media.Header + 24, media.Size - media.Header - 24).Clear(); // the handler's name
                            else if (MetadataBoxes.Contains(media.Type)) Free(moov, media);
                        }
                    }
                }
            }
        }
        return ranges;
    }

    /// <summary>Where a track's samples are in the file: one range per chunk.</summary>
    private static List<(long Offset, long Count)> SampleRanges(byte[] b, Box? mdia)
    {
        var ranges = new List<(long, long)>();
        if (mdia is not { } media || Child(b, media, "minf") is not { } minf || Child(b, minf, "stbl") is not { } stbl) return ranges;
        var stsz = Child(b, stbl, "stsz");
        var stsc = Child(b, stbl, "stsc");
        var stco = Child(b, stbl, "stco");
        var co64 = Child(b, stbl, "co64");
        if (stco is null && co64 is null) return ranges;
        if (stsz is not { } sz || stsc is not { } sc) throw new Refused("This video has an extra track that can't be cleaned.");

        uint U32(int at) => BinaryPrimitives.ReadUInt32BigEndian(b.AsSpan(at));
        var szAt = sz.Start + sz.Header;
        if (sz.Size < sz.Header + 12) throw new Refused("The video is damaged.");
        var fixedSize = U32(szAt + 4);
        var sampleCount = U32(szAt + 8);
        if (fixedSize == 0 && sz.Size < sz.Header + 12 + 4L * sampleCount) throw new Refused("The video is damaged.");
        var scAt = sc.Start + sc.Header;
        var scCount = sc.Size >= sc.Header + 8 ? U32(scAt + 4) : 0;
        if (sc.Size < sc.Header + 8 + 12L * scCount) throw new Refused("The video is damaged.");
        var offsets = (stco ?? co64)!.Value;
        var wide = stco is null;
        var coAt = offsets.Start + offsets.Header;
        var chunkCount = offsets.Size >= offsets.Header + 8 ? U32(coAt + 4) : 0;
        if (offsets.Size < offsets.Header + 8 + (wide ? 8L : 4L) * chunkCount) throw new Refused("The video is damaged.");

        long sample = 0;
        var entry = 0;
        uint perChunk = 0;
        for (uint chunk = 1; chunk <= chunkCount; chunk++)
        {
            while (entry < scCount && U32(scAt + 8 + entry * 12) <= chunk)
            {
                perChunk = U32(scAt + 8 + entry * 12 + 4);
                entry++;
            }
            long bytes = 0;
            for (uint k = 0; k < perChunk && sample < sampleCount; k++, sample++)
                bytes += fixedSize != 0 ? fixedSize : U32(szAt + 12 + (int)sample * 4);
            var at = coAt + 8 + (int)(chunk - 1) * (wide ? 8 : 4);
            var offset = wide ? (long)BinaryPrimitives.ReadUInt64BigEndian(b.AsSpan(at)) : U32(at);
            if (bytes > 0) ranges.Add((offset, bytes));
        }
        return ranges;
    }
}
