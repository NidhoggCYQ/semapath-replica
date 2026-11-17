using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SemaPath.PowerBi;

internal sealed class BridgeFailure(string code) : Exception(code) { public string Code => Message; }
internal sealed class Operation : IDisposable
{
  public CancellationTokenSource Cancel { get; } = new();
  public Action? Interrupt;
  public void Stop() { try { Cancel.Cancel(); Interrupt?.Invoke(); } catch { } }
  public void Dispose() { Interrupt = null; Cancel.Dispose(); }
}
internal static class Program
{
  internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
  static readonly ConcurrentDictionary<string, Operation> Active = new();
  static readonly SemaphoreSlim Output = new(1);
  internal static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
  internal static string Required(JsonElement value, string key) => value.TryGetProperty(key, out var item) && item.ValueKind == JsonValueKind.String && item.GetString() is { Length: > 0 } text ? text : throw new BridgeFailure("PBI_PROTOCOL");
  internal static string Text(object? value) => value switch
  {
    null or DBNull => "",
    decimal d => d.ToString(CultureInfo.InvariantCulture),
    double d when double.IsFinite(d) => d.ToString("R", CultureInfo.InvariantCulture),
    float f when float.IsFinite(f) => f.ToString("R", CultureInfo.InvariantCulture),
    DateTime date => date.ToString("yyyy-MM-ddTHH:mm:ss.fffffff", CultureInfo.InvariantCulture),
    DateTimeOffset date => date.ToString("O", CultureInfo.InvariantCulture),
    bool flag => flag ? "TRUE" : "FALSE",
    byte[] bytes => "0x" + Convert.ToHexStringLower(bytes),
    IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
    _ => value.ToString() ?? ""
  };
  internal static void ReadOnlyDax(string value)
  {
    if (value.Length > 20000) throw new BridgeFailure("PBI_LIMIT");
    var words = new List<string>();
    for (var i = 0; i < value.Length;)
    {
      var c = value[i];
      if (c is '\"' or '\'' or '[')
      {
        var end = c == '[' ? ']' : c; i++; var closed = false;
        while (i < value.Length) { if (value[i++] != end) continue; if (i < value.Length && value[i] == end) { i++; continue; } closed = true; break; }
        if (!closed) throw new BridgeFailure("PBI_DAX_READ_ONLY");
        continue;
      }
      if (c == ';' || value.AsSpan(i).StartsWith("--") || value.AsSpan(i).StartsWith("//") || value.AsSpan(i).StartsWith("/*")) throw new BridgeFailure("PBI_DAX_READ_ONLY");
      var match = Regex.Match(value[i..], "^[A-Za-z_][A-Za-z0-9_]*");
      if (match.Success) { words.Add(match.Value.ToUpperInvariant()); i += match.Length; } else i++;
    }
    if (words.Count == 0 || words[0] is not ("EVALUATE" or "DEFINE") || words.Count(w => w == "EVALUATE") != 1 || words.Any(w => new[] { "CREATE", "ALTER", "DROP", "DELETE", "INSERT", "UPDATE", "REFRESH", "EXECUTE", "XMLA" }.Contains(w))) throw new BridgeFailure("PBI_DAX_READ_ONLY");
  }
  static async Task Reply(string id, object? result, string? error = null)
  {
    var line = JsonSerializer.Serialize(error == null ? (object)new { id, ok = true, result } : new { id, ok = false, error }, Json);
    if (Encoding.UTF8.GetByteCount(line) > 8 * 1024 * 1024) line = JsonSerializer.Serialize(new { id, ok = false, error = "PBI_LIMIT" }, Json);
    await Output.WaitAsync();
    try { await Console.Out.WriteLineAsync(line); await Console.Out.FlushAsync(); } finally { Output.Release(); }
  }
  static async Task Run(string id, string method, JsonElement request, Operation operation)
  {
    try
    {
      object result = method switch
      {
        "ping" => new { protocol = "semapath.powerbi/1", runtime = Environment.Version.ToString() },
        "local.discover" => Native.Discover(operation),
        "local.connect" => Native.ConnectPort(request.GetProperty("port").GetInt32(), operation),
        "local.schema" => Model.ReadLocalSchema(request.GetProperty("model"), operation),
        "local.query" => Model.Query(request.GetProperty("model"), Required(request, "dax"), false, operation),
        "cloud.schema" => Model.ReadCloudSchema(request.GetProperty("model"), operation),
        "cloud.query" => Model.Query(request.GetProperty("model"), Required(request, "dax"), true, operation),
        _ => throw new BridgeFailure("PBI_PROTOCOL")
      };
      operation.Cancel.Token.ThrowIfCancellationRequested();
      await Reply(id, result);
    }
    catch (Exception error)
    {
      var code = operation.Cancel.IsCancellationRequested ? "PBI_CANCELLED" : error is BridgeFailure failure ? failure.Code : error.Message.Contains("timed out", StringComparison.OrdinalIgnoreCase) ? "PBI_TIMEOUT" : method.EndsWith("schema") ? "PBI_METADATA_UNAVAILABLE" : method.EndsWith("query") ? "PBI_QUERY_FAILED" : "PBI_CONNECT_FAILED";
      await Reply(id, null, code);
    }
    finally { Active.TryRemove(id, out _); operation.Dispose(); }
  }
  static async Task Main()
  {
    Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
    var pending = new List<Task>();
    var buffer = new char[4096]; var input = new StringBuilder();
    while (await Console.In.ReadAsync(buffer) is var count && count > 0)
    {
      for (var index = 0; index < count; index++)
      {
        var ch = buffer[index];
        if (ch != '\n') { input.Append(ch); if (input.Length > 65536) return; continue; }
        var line = input.ToString(); input.Clear();
        if (string.IsNullOrWhiteSpace(line)) continue;
        string id = "";
        try
        {
          using var document = JsonDocument.Parse(line); var request = document.RootElement.Clone();
          id = Required(request, "id"); if (!Guid.TryParse(id, out _)) throw new BridgeFailure("PBI_PROTOCOL");
          var method = Required(request, "method");
          if (method == "cancel") { var target = Required(request, "requestId"); var found = Active.TryGetValue(target, out var running); running?.Stop(); await Reply(id, new { requested = found }); continue; }
          if (Active.Count >= 4 || Active.ContainsKey(id)) throw new BridgeFailure("BUSY");
          var operation = new Operation(); if (!Active.TryAdd(id, operation)) throw new BridgeFailure("BUSY");
          pending.Add(Task.Run(() => Run(id, method, request, operation)));
          pending.RemoveAll(t => t.IsCompleted);
        }
        catch { await Reply(id, null, "PBI_PROTOCOL"); }
      }
    }
    foreach (var operation in Active.Values) operation.Stop();
    await Task.WhenAll(pending);
  }
}
