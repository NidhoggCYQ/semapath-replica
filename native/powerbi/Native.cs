using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using TOM = Microsoft.AnalysisServices.Tabular;

namespace SemaPath.PowerBi;

internal static class Native
{
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry { public uint Size, Usage, Id; public IntPtr Heap; public uint Module, Threads, Parent; public int Priority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint id);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr handle, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr handle, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("iphlpapi.dll", SetLastError = true)] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int type, uint reserved);
  internal sealed record Endpoint(int Port, int ProcessId, string StartedAt);
  internal static List<Endpoint> Endpoints(bool desktopOnly)
  {
    if (!OperatingSystem.IsWindows()) throw new BridgeFailure("PBI_BRIDGE_UNAVAILABLE");
    var tree = new Dictionary<uint, Entry>(); var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new BridgeFailure("PBI_CONNECT_FAILED");
    try { var e = new Entry { Size = (uint)Marshal.SizeOf<Entry>() }; if (Process32First(snapshot, ref e)) do { tree[e.Id] = e; } while (Process32Next(snapshot, ref e)); } finally { CloseHandle(snapshot); }
    var servers = new Dictionary<int, string>();
    foreach (var entry in tree.Values.Where(e => e.Name.Equals("msmdsrv.exe", StringComparison.OrdinalIgnoreCase)))
    {
      var parent = entry.Parent; var owned = false; var seen = new HashSet<uint>();
      while (seen.Add(parent) && tree.TryGetValue(parent, out var p)) { if (p.Name.Equals("PBIDesktop.exe", StringComparison.OrdinalIgnoreCase)) { owned = true; break; } parent = p.Parent; }
      if (desktopOnly && !owned) continue;
      try { using var p = Process.GetProcessById((int)entry.Id); servers[(int)entry.Id] = p.StartTime.ToUniversalTime().ToString("O"); } catch { }
    }
    var size = 0; GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 3, 0);
    if (size <= 0) return [];
    var data = Marshal.AllocHGlobal(size); var result = new List<Endpoint>();
    try
    {
      if (GetExtendedTcpTable(data, ref size, false, 2, 3, 0) != 0) throw new BridgeFailure("PBI_CONNECT_FAILED");
      var count = Marshal.ReadInt32(data);
      for (var i = 0; i < count; i++)
      {
        var row = IntPtr.Add(data, 4 + i * 24); var pid = Marshal.ReadInt32(row, 20);
        if (!servers.TryGetValue(pid, out var start)) continue;
        var bytes = BitConverter.GetBytes(Marshal.ReadInt32(row, 8)); var port = bytes[0] * 256 + bytes[1];
        if (port > 0) result.Add(new Endpoint(port, pid, start));
      }
    }
    finally { Marshal.FreeHGlobal(data); }
    return result.Distinct().Take(16).ToList();
  }
  internal static string Identity(Endpoint endpoint, string databaseId) => Program.Hash($"{endpoint.ProcessId}|{endpoint.StartedAt}|{endpoint.Port}|{databaseId}");
  internal static Endpoint AssertLocal(JsonElement model)
  {
    var endpoint = Endpoints(false).SingleOrDefault(e => e.Port == model.GetProperty("port").GetInt32() && e.ProcessId == model.GetProperty("processId").GetInt32() && e.StartedAt == Program.Required(model, "startedAt"));
    if (endpoint == null || Identity(endpoint, Program.Required(model, "databaseId")) != Program.Required(model, "id")) throw new BridgeFailure("PBI_MODEL_CHANGED");
    return endpoint;
  }
  static object[] List(Endpoint endpoint, Operation operation)
  {
    operation.Cancel.Token.ThrowIfCancellationRequested();
    using var server = new TOM.Server();
    operation.Interrupt = () => server.Disconnect();
    server.Connect(Model.ConnectionString($"localhost:{endpoint.Port}", null, 3));
    var result = server.Databases.Cast<TOM.Database>().Select(db => new { id = Identity(endpoint, db.ID), port = endpoint.Port, databaseId = db.ID, name = db.Name, processId = endpoint.ProcessId, startedAt = endpoint.StartedAt }).Cast<object>().ToArray();
    operation.Interrupt = null; return result;
  }
  internal static object[] Discover(Operation operation)
  {
    var models = new List<object>();
    foreach (var endpoint in Endpoints(true)) { try { models.AddRange(List(endpoint, operation)); } catch { operation.Cancel.Token.ThrowIfCancellationRequested(); } }
    return models.ToArray();
  }
  internal static object[] ConnectPort(int port, Operation operation)
  {
    if (port < 1 || port > 65535) throw new BridgeFailure("PBI_PROTOCOL");
    var endpoint = Endpoints(false).SingleOrDefault(e => e.Port == port) ?? throw new BridgeFailure("PBI_NOT_FOUND");
    return List(endpoint, operation);
  }
}
