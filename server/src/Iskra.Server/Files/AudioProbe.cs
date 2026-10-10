using System.Buffers.Binary;

namespace Iskra.Server.Files;

/// <summary>
/// Works out how long a short sound is from its own bytes (WAV, Ogg Vorbis/Opus, MP3), so the server never
/// has to trust a client about it. Returns null when the file doesn't parse as the format it sniffed as.
/// </summary>
public static class AudioProbe
{
    public static int? DurationMs(ReadOnlySpan<byte> data, string type) => type switch
    {
        "audio/wav" => Wav(data),
        "audio/ogg" => Ogg(data),
        "audio/mpeg" => Mp3(data),
        _ => null,
    };

    private static int? Wav(ReadOnlySpan<byte> data)
    {
        if (data.Length < 12) return null;
        long byteRate = 0;
        for (var i = 12; i + 8 <= data.Length;)
        {
            var id = data.Slice(i, 4);
            var size = BinaryPrimitives.ReadUInt32LittleEndian(data[(i + 4)..]);
            if (id.SequenceEqual("fmt "u8) && size >= 16 && i + 24 <= data.Length)
                byteRate = BinaryPrimitives.ReadUInt32LittleEndian(data[(i + 16)..]);
            else if (id.SequenceEqual("data"u8))
            {
                if (byteRate == 0) return null;
                var bytes = Math.Min(size, (uint)(data.Length - i - 8)); // a streaming writer may leave the size open
                return (int)(bytes * 1000 / byteRate);
            }
            i += 8 + (int)Math.Min(size + (size & 1), int.MaxValue - 16);
        }
        return null;
    }

    private static int? Ogg(ReadOnlySpan<byte> data)
    {
        // The first page carries the codec header; the last page's granule position is the length in samples.
        if (data.Length < 28 + 19 || !data.StartsWith("OggS"u8)) return null;
        var segments = data[26];
        var payload = 27 + segments;
        if (payload + 19 > data.Length) return null;
        var head = data[payload..];
        long rate, skip = 0;
        if (head.Length >= 16 && head[0] == 1 && head[1..7].SequenceEqual("vorbis"u8))
            rate = BinaryPrimitives.ReadUInt32LittleEndian(head[12..]);
        else if (head.StartsWith("OpusHead"u8))
        {
            rate = 48_000; // Opus granules always count 48 kHz samples
            skip = BinaryPrimitives.ReadUInt16LittleEndian(head[10..]);
        }
        else return null;
        if (rate == 0) return null;

        for (var i = data.Length - 27; i >= 0; i--)
        {
            if (data[i] != (byte)'O' || !data[i..].StartsWith("OggS"u8)) continue;
            var granule = BinaryPrimitives.ReadInt64LittleEndian(data[(i + 6)..]);
            if (granule < 0) continue;
            return (int)Math.Max(0, (granule - skip) * 1000 / rate);
        }
        return null;
    }

    private static readonly int[] Mp3BitratesV1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    private static readonly int[] Mp3BitratesV2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    private static readonly int[] Mp3Rates = [44_100, 48_000, 32_000];

    /// <summary>Walks every MPEG audio frame (layer III) and adds up their samples.</summary>
    private static int? Mp3(ReadOnlySpan<byte> data)
    {
        var i = 0;
        if (data.StartsWith("ID3"u8) && data.Length >= 10)
            i = 10 + (data[6] << 21 | data[7] << 14 | data[8] << 7 | data[9]);
        double seconds = 0;
        var frames = 0;
        while (i + 4 <= data.Length)
        {
            if (data[i] != 0xFF || (data[i + 1] & 0xE0) != 0xE0)
            {
                if (frames > 0 && data[i..].StartsWith("TAG"u8)) break; // ID3v1 trailer
                if (frames > 0) return null;                          // garbage between frames
                i++;                                                    // padding before the first frame
                if (i > 4096) return null;
                continue;
            }
            var version = (data[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
            var layer = (data[i + 1] >> 1) & 3;   // 1 = layer III
            var bitrateIndex = data[i + 2] >> 4;
            var rateIndex = (data[i + 2] >> 2) & 3;
            var padding = (data[i + 2] >> 1) & 1;
            if (version == 1 || layer != 1 || bitrateIndex is 0 or 15 || rateIndex == 3) return null;
            var mpeg1 = version == 3;
            var rate = Mp3Rates[rateIndex] / (version == 3 ? 1 : version == 2 ? 2 : 4);
            var bitrate = (mpeg1 ? Mp3BitratesV1L3 : Mp3BitratesV2L3)[bitrateIndex] * 1000;
            var samples = mpeg1 ? 1152 : 576;
            var length = samples / 8 * bitrate / rate + padding;
            if (length < 4) return null;
            seconds += (double)samples / rate;
            frames++;
            i += length;
        }
        return frames == 0 ? null : (int)(seconds * 1000);
    }
}
