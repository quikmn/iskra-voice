using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Templates;

namespace Iskra.Server.Features;

/// <summary>
/// "Save this server as a template": admins get the server's setup as a starter template (format 2, docs/templates.md),
/// checked by the same validator that reads templates, so what they save can start a new server.
/// </summary>
public static class TemplateFeature
{
    public static void Register(Router router) => router.Add("server.template.export", Export);

    private static object Export(Session s, Member me, Body body)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can save this server as a template.", "admins_template_export");
        var json = TemplateExport.Build(s.World, me).ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        try
        {
            ServerTemplates.Parse(json, "export");
        }
        catch (TemplateException ex)
        {
            throw RequestException.BadRequest($"This server can't be saved as a template: {ex.Message}", "template_export_invalid", new { problem = ex.Message });
        }
        Audit.Record(s, "server.template.export");
        using var doc = JsonDocument.Parse(json);
        return new { template = doc.RootElement.Clone() };
    }
}
