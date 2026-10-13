using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Updates;
using Sigstore;

namespace Iskra.Server.Tests;

/// <summary>
/// Release attestations, verified offline against the compiled-in Sigstore root, with the real bundles GitHub holds
/// for the 2.0.0-alpha.12 Linux server package (Fixtures/: GitHub's answer to /attestations/sha256:..., saved as is).
/// </summary>
public class AttestationTests
{
    private const string Version = "2.0.0-alpha.12";
    private const string Name = "iskra-server-2.0.0-alpha.12-linux-x64.tar.gz";
    private const string Sha = "4a3cb2b59c192457f224308ef0d09f55c4a1c18002bb5b26a5fedab6ba267336";
    private const string OtherSha = "964b37d604ea92df35c9e71d73c6d13a7e22f191e841f6475708181fe66ba61e"; // the osx-arm64 package

    public static IReadOnlyList<string> RealBundles()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "attestations-2.0.0-alpha.12-linux-x64.json")));
        return Attestations.ParseList(doc);
    }

    private static Task<AttestationResult> Verify(IReadOnlyList<string>? bundles, string name = Name, string sha = Sha, string version = Version, TrustedRoot? root = null) =>
        Attestations.VerifyAsync(bundles, name, sha, version, root ?? Attestations.PinnedRoot, CancellationToken.None);

    [Fact]
    public async Task A_real_release_package_verifies_with_either_release_workflow_signature()
    {
        var bundles = RealBundles();
        Assert.Equal(2, bundles.Count); // release.yml (at the tag) and release-finalize.yml (on main)
        Assert.Equal(AttestationResult.Verified, await Verify(bundles));
        Assert.Equal(AttestationResult.Verified, await Verify([bundles[0]]));
        Assert.Equal(AttestationResult.Verified, await Verify([bundles[1]]));
    }

    [Fact]
    public async Task The_statement_must_name_this_file_with_this_hash()
    {
        var bundles = RealBundles();
        Assert.Equal(AttestationResult.Invalid, await Verify(bundles, sha: new string('a', 64)));
        // Another genuine file of the same release isn't this one.
        Assert.Equal(AttestationResult.Invalid, await Verify(bundles, sha: OtherSha));
        Assert.Equal(AttestationResult.Invalid, await Verify(bundles, name: "iskra-server-2.0.0-alpha.12-osx-arm64.tar.gz"));
        Assert.Equal(AttestationResult.Invalid, await Verify(bundles, name: "iskra-server-2.0.0-alpha.13-linux-x64.tar.gz"));
    }

    [Fact]
    public async Task Only_this_repositorys_release_workflows_count()
    {
        // release.yml signed at the tag v2.0.0-alpha.12: for another version only finalize's signature (on main) could count.
        var bundles = RealBundles();
        var fromTag = bundles.Single(b => Statement(b).Contains("refs/tags/v2.0.0-alpha.12"));
        Assert.Equal(AttestationResult.Invalid, await Verify([fromTag], version: "2.0.0-alpha.11"));
        Assert.Equal(
        [
            "https://github.com/quikmn/iskra-voice/.github/workflows/release.yml@refs/tags/v2.1.0",
            "https://github.com/quikmn/iskra-voice/.github/workflows/release-finalize.yml@refs/heads/main",
        ], Attestations.Signers("2.1.0"));
    }

    [Fact]
    public async Task A_changed_bundle_or_an_unknown_root_never_verifies()
    {
        var bundle = JsonNode.Parse(RealBundles()[0])!;
        // Change the signed statement: the DSSE signature no longer matches.
        var payload = JsonNode.Parse(Convert.FromBase64String(bundle["dsseEnvelope"]!["payload"]!.GetValue<string>()))!;
        payload["subject"]!.AsArray().Add(new JsonObject { ["name"] = "evil.tar.gz", ["digest"] = new JsonObject { ["sha256"] = new string('e', 64) } });
        var changed = bundle.DeepClone();
        changed["dsseEnvelope"]!["payload"] = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(payload.ToJsonString()));
        Assert.Equal(AttestationResult.Invalid, await Verify([changed.ToJsonString()], name: "evil.tar.gz", sha: new string('e', 64)));
        Assert.Equal(AttestationResult.Invalid, await Verify([changed.ToJsonString()]));

        // No transparency log entry.
        var unlogged = bundle.DeepClone();
        unlogged["verificationMaterial"]!["tlogEntries"] = new JsonArray();
        Assert.Equal(AttestationResult.Invalid, await Verify([unlogged.ToJsonString()]));

        // A root without Sigstore's certificate authorities: the bundle's own certificate proves nothing.
        var root = JsonNode.Parse(File.ReadAllText(SourceRoot()))!;
        root["certificateAuthorities"] = new JsonArray();
        Assert.Equal(AttestationResult.Invalid, await Verify(RealBundles(), root: TrustedRoot.Deserialize(root.ToJsonString())));
    }

    [Fact]
    public async Task None_and_unreachable_are_told_apart()
    {
        Assert.Equal(AttestationResult.Missing, await Verify([]));
        Assert.Equal(AttestationResult.Unknown, await Verify(null));
        Assert.Equal(AttestationResult.Invalid, await Verify(["", "[]", "{}", "not json"]));
    }

    [Fact]
    public void The_compiled_in_root_is_sigstores_public_good_one()
    {
        var root = Attestations.PinnedRoot;
        Assert.Contains(root.TransparencyLogs, t => t.BaseUrl.Host == "rekor.sigstore.dev");
        Assert.Contains(root.CertificateAuthorities, c => c.Uri.Host == "fulcio.sigstore.dev");
    }

    private static string Statement(string bundle)
    {
        var payload = JsonNode.Parse(bundle)!["dsseEnvelope"]!["payload"]!.GetValue<string>();
        return System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(payload));
    }

    private static string SourceRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "server", "src", "Iskra.Server", "Updates", "sigstore-trusted-root.json"))) dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, "server", "src", "Iskra.Server", "Updates", "sigstore-trusted-root.json");
    }
}
