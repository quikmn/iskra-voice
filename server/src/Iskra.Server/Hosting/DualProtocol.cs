using System.IO.Pipelines;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.Connections;
using Microsoft.AspNetCore.Http.Features;

namespace Iskra.Server.Hosting;

/// <summary>
/// Lets one port speak both plain HTTP (LAN, localhost, Let's Encrypt's check) and HTTPS (friends on the
/// internet): the first byte of a TLS connection is always 0x16 (handshake record), which no HTTP request
/// starts with. Internet hosting can then be switched on at runtime without rebinding ports.
/// </summary>
public static class DualProtocol
{
    private const byte TlsHandshake = 0x16;
    private static readonly TimeSpan HandshakeTimeout = TimeSpan.FromSeconds(10);

    public static Func<ConnectionDelegate, ConnectionDelegate> Middleware(Func<SslStreamCertificateContext> certificate) => next => async context =>
    {
        var input = context.Transport.Input;
        ReadResult peek;
        try
        {
            using var timeout = new CancellationTokenSource(HandshakeTimeout);
            peek = await input.ReadAtLeastAsync(1, timeout.Token);
        }
        catch (OperationCanceledException)
        {
            return; // connected and said nothing
        }
        var isTls = peek.Buffer.Length > 0 && peek.Buffer.FirstSpan[0] == TlsHandshake;
        input.AdvanceTo(peek.Buffer.Start); // nothing consumed: whoever reads next sees the same bytes
        if (!isTls)
        {
            await next(context);
            return;
        }

        var transport = context.Transport;
        await using var ssl = new SslStream(new DuplexPipeStream(transport), leaveInnerStreamOpen: true);
        try
        {
            using var timeout = new CancellationTokenSource(HandshakeTimeout);
            await ssl.AuthenticateAsServerAsync(new SslServerAuthenticationOptions
            {
                ServerCertificateContext = certificate(),
                ApplicationProtocols = [SslApplicationProtocol.Http11],
                EnabledSslProtocols = SecurityHeaders.Protocols,
                ClientCertificateRequired = false,
                CertificateRevocationCheckMode = X509RevocationMode.NoCheck,
            }, timeout.Token);
        }
        catch (Exception ex) when (ex is System.Security.Authentication.AuthenticationException or IOException or OperationCanceledException)
        {
            return; // bad or slow handshake: just drop it
        }

        var pipe = new SslPipe(PipeReader.Create(ssl, new StreamPipeReaderOptions(leaveOpen: true)), PipeWriter.Create(ssl, new StreamPipeWriterOptions(leaveOpen: true)));
        context.Transport = pipe;
        context.Features.Set<ITlsConnectionFeature>(new TlsFeature(ssl));
        try
        {
            await next(context);
        }
        finally
        {
            await pipe.Input.CompleteAsync();
            await pipe.Output.CompleteAsync();
            context.Transport = transport;
        }
    };

    private sealed record SslPipe(PipeReader Input, PipeWriter Output) : IDuplexPipe;

    private sealed class TlsFeature(SslStream ssl) : ITlsConnectionFeature
    {
        public X509Certificate2? ClientCertificate { get; set; } = ssl.RemoteCertificate as X509Certificate2;
        public Task<X509Certificate2?> GetClientCertificateAsync(CancellationToken cancellationToken) => Task.FromResult(ClientCertificate);
    }

    /// <summary>The raw connection as a Stream, for SslStream to read and write through.</summary>
    private sealed class DuplexPipeStream(IDuplexPipe pipe) : Stream
    {
        private readonly Stream _input = pipe.Input.AsStream(leaveOpen: true);
        private readonly Stream _output = pipe.Output.AsStream(leaveOpen: true);

        public override bool CanRead => true;
        public override bool CanWrite => true;
        public override bool CanSeek => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count) => _input.Read(buffer, offset, count);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => _input.ReadAsync(buffer, cancellationToken);
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            _input.ReadAsync(buffer, offset, count, cancellationToken);
        public override void Write(byte[] buffer, int offset, int count) => _output.Write(buffer, offset, count);
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) => _output.WriteAsync(buffer, cancellationToken);
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            _output.WriteAsync(buffer, offset, count, cancellationToken);
        public override void Flush() => _output.Flush();
        public override Task FlushAsync(CancellationToken cancellationToken) => _output.FlushAsync(cancellationToken);
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
