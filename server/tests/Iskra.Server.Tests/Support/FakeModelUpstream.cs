using System.Security.Cryptography;
using Iskra.Server.Captions;

namespace Iskra.Server.Tests.Support;

/// <summary>A tiny stand-in for the captions model and Hugging Face: two files, one in two parts.</summary>
public sealed class FakeModelUpstream : IModelUpstream
{
    public static readonly byte[] Encoder = [.. Enumerable.Range(0, 300).Select(i => (byte)i)];
    public static readonly byte[] Vocab = "{\"hello\":0}"u8.ToArray();

    public ModelManifest Manifest { get; } = new("test-model", "test-model-1234", "https://upstream.test/model",
    [
        File("encoder.q8.onnx", Encoder, 200),
        File("vocab.json", Vocab, 1000),
    ]);

    /// <summary>How many times each file was fetched.</summary>
    public Dictionary<string, int> Fetches { get; } = [];
    /// <summary>Serve these bytes instead (a tampered upstream).</summary>
    public byte[]? Tampered { get; set; }
    /// <summary>Holds every fetch until set.</summary>
    public TaskCompletionSource? Gate { get; set; }
    public bool Fail { get; set; }

    public async Task<byte[]> GetFileAsync(ModelManifest manifest, ModelFile file, CancellationToken cancel)
    {
        lock (Fetches) Fetches[file.Name] = Fetches.GetValueOrDefault(file.Name) + 1;
        if (Gate is { } gate) await gate.Task;
        if (Fail) throw new HttpRequestException("upstream down");
        return Tampered ?? (file.Name == "vocab.json" ? Vocab : Encoder);
    }

    private static ModelFile File(string name, byte[] data, int partSize)
    {
        var parts = data.Chunk(partSize).Select(p => new ModelPart(Hex(p), p.Length)).ToArray();
        return new ModelFile(name, name, Hex(data), data.Length, parts);
    }

    private static string Hex(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));
}
