using System.Data.Common;
using System.Text.Json;
using ADOMD = Microsoft.AnalysisServices.AdomdClient;
using TOM = Microsoft.AnalysisServices.Tabular;

namespace SemaPath.PowerBi;

internal static class Model
{
  internal static string ConnectionString(string source, string? database, int timeout = 10)
  {
    var value = new DbConnectionStringBuilder { ["Data Source"] = source, ["Connect Timeout"] = timeout, ["Timeout"] = 90 };
    if (database != null) value["Initial Catalog"] = database;
    return value.ConnectionString;
  }
  static (string Source, string Database) Target(JsonElement model, bool cloud)
  {
    if (!cloud) { Native.AssertLocal(model); return ($"localhost:{model.GetProperty("port").GetInt32()}", Program.Required(model, "databaseId")); }
    var env = Program.Required(model, "environment");
    if (env is not ("global" or "china") || !Guid.TryParse(Program.Required(model, "tenantId"), out _) || !Guid.TryParse(Program.Required(model, "workspaceId"), out _) || !Guid.TryParse(Program.Required(model, "datasetId"), out _)) throw new BridgeFailure("PBI_PROTOCOL");
    var host = env == "china" ? "api.powerbi.cn" : "api.powerbi.com";
    return ($"powerbi://{host}/v1.0/{Program.Required(model, "tenantId")}/{Uri.EscapeDataString(Program.Required(model, "workspaceName"))}", Program.Required(model, "datasetId"));
  }
  static Microsoft.AnalysisServices.AccessToken Token(JsonElement model)
  {
    var expiry = DateTimeOffset.Parse(Program.Required(model, "expiresOn"));
    if (expiry <= DateTimeOffset.UtcNow) throw new BridgeFailure("PBI_AUTH_REQUIRED");
    return new Microsoft.AnalysisServices.AccessToken(Program.Required(model, "accessToken"), expiry, null);
  }
  static object Schema(JsonElement target, bool cloud, Operation operation)
  {
    var (source, database) = Target(target, cloud);
    using var server = new TOM.Server(); if (cloud) server.AccessToken = Token(target);
    operation.Interrupt = () => server.Disconnect();
    server.Connect(ConnectionString(source, database));
    operation.Cancel.Token.ThrowIfCancellationRequested();
    var db = server.Databases.Cast<TOM.Database>().SingleOrDefault(d => d.ID.Equals(database, StringComparison.OrdinalIgnoreCase)) ?? throw new BridgeFailure("PBI_MODEL_CHANGED");
    var model = db.Model;
    if (model.Tables.Count > 500 || model.Tables.Sum(t => t.Columns.Count + t.Measures.Count) > 10000) throw new BridgeFailure("PBI_LIMIT");
    var tables = model.Tables.Select(t => new
    {
      name = t.Name,
      hidden = t.IsHidden,
      description = t.Description ?? "",
      columns = t.Columns.Select(c => new { name = c.Name, type = c.DataType.ToString(), hidden = c.IsHidden, formatString = c.FormatString ?? "", expression = c is TOM.CalculatedColumn calculated ? calculated.Expression ?? "" : "" }).ToArray(),
      measures = t.Measures.Select(m => new { name = m.Name, expression = m.Expression ?? "", formatString = m.FormatString ?? "", description = m.Description ?? "", hidden = m.IsHidden }).ToArray()
    }).ToArray();
    var relationships = model.Relationships.OfType<TOM.SingleColumnRelationship>().Select(r => new { name = r.Name, fromTable = r.FromTable.Name, fromColumn = r.FromColumn.Name, toTable = r.ToTable.Name, toColumn = r.ToColumn.Name, active = r.IsActive, crossFilter = r.CrossFilteringBehavior.ToString() }).ToArray();
    var completeRelationships = relationships.Length == model.Relationships.Count;
    var result = new { fetchedAt = DateTimeOffset.UtcNow.ToString("O"), source = cloud ? "cloud_xmla" : "local_tom", coverage = new { tables = "available", columns = "available", measures = "available", relationships = completeRelationships ? "available" : "partial" }, tables, relationships, issues = completeRelationships ? Array.Empty<object>() : new object[] { new { area = "relationships", code = "UNSUPPORTED_RELATIONSHIP" } } };
    if (JsonSerializer.SerializeToUtf8Bytes(result, Program.Json).Length > 2 * 1024 * 1024) throw new BridgeFailure("PBI_LIMIT");
    if (!cloud) Native.AssertLocal(target);
    operation.Interrupt = null; return result;
  }
  internal static object ReadLocalSchema(JsonElement model, Operation operation) => Schema(model, false, operation);
  internal static object ReadCloudSchema(JsonElement model, Operation operation) => Schema(model, true, operation);
  static string SchemaHash(object schema)
  {
    var json = JsonSerializer.SerializeToElement(schema, Program.Json);
    return Program.Hash(JsonSerializer.Serialize(new { tables = json.GetProperty("tables"), relationships = json.GetProperty("relationships") }, Program.Json));
  }
  internal static object Query(JsonElement model, string dax, bool cloud, Operation operation)
  {
    Program.ReadOnlyDax(dax);
    var schema = Schema(model, cloud, operation); var fingerprint = SchemaHash(schema);
    var (source, database) = Target(model, cloud);
    using var connection = new ADOMD.AdomdConnection(ConnectionString(source, database));
    if (cloud) connection.AccessToken = Token(model);
    operation.Interrupt = () => connection.Close(); connection.Open();
    using var command = connection.CreateCommand(); command.CommandTimeout = 90; command.CommandText = dax;
    operation.Interrupt = () => { command.Cancel(); connection.Close(); };
    using var reader = command.ExecuteReader();
    if (reader.FieldCount > 40) throw new BridgeFailure("PBI_LIMIT");
    var columns = Enumerable.Range(0, reader.FieldCount).Select(i => new { name = reader.GetName(i), type = reader.GetFieldType(i).Name }).ToArray();
    if (columns.Select(c => c.name).Distinct().Count() != columns.Length) throw new BridgeFailure("PBI_QUERY_FAILED");
    var rows = new List<string?[]>(); var bytes = 0;
    while (reader.Read())
    {
      operation.Cancel.Token.ThrowIfCancellationRequested();
      var row = Enumerable.Range(0, reader.FieldCount).Select(i => reader.IsDBNull(i) ? null : Program.Text(reader.GetValue(i))).ToArray();
      bytes += JsonSerializer.SerializeToUtf8Bytes(row, Program.Json).Length;
      if (rows.Count >= 5000 || bytes > 4 * 1024 * 1024) throw new BridgeFailure("PBI_LIMIT"); rows.Add(row);
    }
    if (reader.NextResult()) throw new BridgeFailure("PBI_QUERY_FAILED");
    reader.Close(); connection.Close(); operation.Interrupt = null;
    var after = Schema(model, cloud, operation);
    if (SchemaHash(after) != fingerprint) throw new BridgeFailure("PBI_MODEL_CHANGED");
    return new { data = new { columns, rows, complete = true }, schema, schemaSha256 = fingerprint };
  }
}
