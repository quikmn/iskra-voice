using Microsoft.Extensions.Configuration;

namespace Iskra.Server.Tests;

public class CommandLineTests
{
    [Fact]
    public void An_absolute_unix_world_path_is_not_read_as_a_switch()
    {
        // Regression: ASP.NET took "/tmp/world" as a "/key value" switch and swallowed the switch after it.
        var (world, config) = CommandLine.Split(["/tmp/world", "--Internet:TestRouter=203.0.113.7"]);
        Assert.Equal("/tmp/world", world);
        Assert.Equal(["--Internet:TestRouter=203.0.113.7"], config);
        var settings = new ConfigurationBuilder().AddCommandLine(config).Build();
        Assert.Equal("203.0.113.7", settings["Internet:TestRouter"]);
    }

    [Fact]
    public void Switch_values_are_not_taken_for_the_world()
    {
        var (world, config) = CommandLine.Split(["--Port", "5000", "--Https:Mode=off", @"C:\worlds\home", "--LocalOnly=true"]);
        Assert.Equal(@"C:\worlds\home", world);
        Assert.Equal(["--Port", "5000", "--Https:Mode=off", "--LocalOnly=true"], config);
    }

    [Fact]
    public void No_world_argument()
    {
        var (world, config) = CommandLine.Split(["--World=here"]);
        Assert.Null(world);
        Assert.Equal(["--World=here"], config);
    }
}
