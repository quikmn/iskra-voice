namespace Iskra.Server;

/// <summary>Splits <c>iskra-server &lt;world-folder&gt; [--Key=value ...]</c> into the world folder and the configuration switches.</summary>
public static class CommandLine
{
    /// <summary>
    /// The first argument that isn't a switch is the world folder; it's kept away from ASP.NET's command-line
    /// configuration, which reads an argument starting with "/" (any absolute path on Linux and macOS) as a
    /// "/key value" switch and would take the next argument as its value.
    /// </summary>
    public static (string? World, string[] Config) Split(string[] args)
    {
        var index = -1;
        for (var i = 0; i < args.Length && index < 0; i++)
        {
            if (!args[i].StartsWith('-')) index = i;
            else if (!args[i].Contains('=')) i++; // "--Key value": the next argument is the value
        }
        return index < 0 ? (null, args) : (args[index], [.. args[..index], .. args[(index + 1)..]]);
    }
}
