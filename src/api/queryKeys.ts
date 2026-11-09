export const qk = {
  connection: ["connection"] as const,
  schemas: ["schemas"] as const,
  objectTypes: (schemaId: string) => ["objectTypes", schemaId] as const,
  attributes: (typeId: string) => ["attributes", typeId] as const,
  statusTypes: (schemaId: string) => ["statusTypes", schemaId] as const,
  objects: (aql: string) => ["objects", aql] as const,
  count: (aql: string) => ["count", aql] as const,
  object: (id: string) => ["object", id] as const,
  history: (id: string) => ["history", id] as const,
  referenceInfo: (id: string) => ["referenceInfo", id] as const,
  inbound: (key: string) => ["inbound", key] as const,
  refSearch: (typeId: string, term: string) => ["refSearch", typeId, term] as const,
};
