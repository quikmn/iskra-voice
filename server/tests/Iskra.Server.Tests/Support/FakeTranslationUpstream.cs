using System.Security.Cryptography;
using Iskra.Server.Captions;
using Iskra.Server.Translate;

namespace Iskra.Server.Tests.Support;

/// <summary>A tiny stand-in for the translation models and Mozilla's storage: English to and from Swedish.</summary>
public sealed class FakeTranslationUpstream : IModelUpstream
{
    public static readonly byte[] Model = [.. Enumerable.Range(0, 300).Select(i => (byte)(i * 7))];
    public static readonly byte[] Vocab = "spm"u8.ToArray();

    public TranslationPins Pins { get; } = new(
    [
        Pin("en", "sv", "translate-ensv-test"),
        Pin("sv", "en", "translate-sven-test"),
    ]);

    /// <summary>How many times each file was fetched ("dir/name").</summary>
    public Dictionary<string, int> Fetches { get; } = [];
    /// <summary>Serve these bytes instead (a tampered upstream).</summary>
    public byte[]? Tampered { get; set; }

    public Task<byte[]> GetFileAsync(ModelManifest manifest, ModelFile file, CancellationToken cancel)
    {
        lock (Fetches) Fetches[$"{manifest.Dir}/{file.Name}"] = Fetches.GetValueOrDefault($"{manifest.Dir}/{file.Name}") + 1;
        return Task.FromResult(Tampered ?? (file.Name == "vocab.spm.gz" ? Vocab : Model));
    }

    private static TranslationPin Pin(string from, string to, string dir) =>
        new($"{from}-{to}", from, to, dir, "https://upstream.test/translate", [File("model.bin.gz", Model, 200), File("vocab.spm.gz", Vocab, 1000)]);

    private static ModelFile File(string name, byte[] data, int partSize)
    {
        var parts = data.Chunk(partSize).Select(p => new ModelPart(Hex(p), p.Length)).ToArray();
        return new ModelFile(name, name, Hex(data), data.Length, parts);
    }

    private static string Hex(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));
}
