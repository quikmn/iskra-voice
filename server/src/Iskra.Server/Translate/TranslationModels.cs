using System.Reflection;
using System.Text.Json;
using Iskra.Server.Captions;
using Iskra.Server.Storage;

namespace Iskra.Server.Translate;

/// <summary>
/// One translation model (one direction, to or from English): Mozilla's Firefox Translations model, gzipped as Mozilla
/// publishes it, in parts of at most 20 MiB. The apps unpack and run it on the device (Bergamot).
/// </summary>
public sealed record TranslationPin(string Name, string From, string To, string Dir, string Source, ModelFile[] Files)
{
    public ModelManifest Manifest => new(Name, Dir, Source, Files);

    public long Bytes => Files.Sum(f => f.Bytes);
}

/// <summary>The pins: client/src/state/translate/models.json, compiled into both the app and this server.</summary>
public sealed record TranslationPins(TranslationPin[] Models)
{
    private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };

    public static TranslationPins Pinned { get; } = Load();

    private static TranslationPins Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("translate-models.json")
            ?? throw new InvalidOperationException("translate-models.json isn't compiled in");
        return JsonSerializer.Deserialize<TranslationPins>(stream, Options) ?? throw new InvalidOperationException("translate-models.json is empty");
    }
}

/// <summary>Where the server gets translation models from (Mozilla's model storage, or a folder). Swapped for a fake in tests.</summary>
public sealed class TranslationUpstream(IModelUpstream inner)
{
    public IModelUpstream Inner { get; } = inner;
}

/// <summary>
/// The translation models in models/translate/&lt;dir&gt;/: each one fetched once, the first time a member's app asks for
/// it, and served from disk after that. Only the models members actually use are ever fetched.
/// </summary>
public sealed class TranslationModelService
{
    private readonly World _world;
    private readonly Dictionary<string, PinnedModel> _byDir;

    public TranslationModelService(World world, TranslationUpstream upstream, TranslationPins pins, TimeProvider time, ILogger<TranslationModelService> log)
    {
        _world = world;
        Pins = pins;
        _byDir = pins.Models.ToDictionary(m => m.Dir, m =>
            new PinnedModel(world, upstream.Inner, m.Manifest, System.IO.Path.Combine(world.Path, "models", "translate", m.Dir), "translate.model", time, log),
            StringComparer.Ordinal);
    }

    public TranslationPins Pins { get; }

    /// <summary>The owner offers translation models to members (Server settings → Translation; server.json Translate.Offer).</summary>
    public bool Enabled => _world.Settings.Translate.Offer;

    public PinnedModel? ByDir(string dir) => _byDir.GetValueOrDefault(dir);

    /// <summary>The models already on this server (names like "en-sv").</summary>
    public string[] Downloaded => [.. Pins.Models.Where(m => _byDir[m.Dir].Complete).Select(m => m.Name)];
}
