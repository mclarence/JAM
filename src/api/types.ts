// Types modelled on docs/jira_assets_api_spec.json (JIRA Assets Cloud REST v1).

export interface Icon {
  id?: string;
  name?: string;
  url16?: string;
  url48?: string;
}

export interface ObjectSchema {
  id: string;
  name: string;
  objectSchemaKey: string;
  description?: string;
  objectCount?: number;
  objectTypeCount?: number;
}

export interface PagedResult<T> {
  startAt: number;
  maxResults: number;
  total: number;
  isLast: boolean | string;
  values: T[];
}

export interface ObjectType {
  id: string;
  name: string;
  description?: string;
  icon?: Icon;
  objectSchemaId: string;
  objectCount?: number;
  abstractObjectType?: boolean;
  position?: number;
}

/** ObjectTypeAttribute.type */
export const AttrType = {
  Default: 0,
  ObjectReference: 1,
  User: 2,
  Group: 4,
  Status: 7,
} as const;

/** DefaultType.id */
export const DefaultType = {
  None: -1,
  Text: 0,
  Integer: 1,
  Boolean: 2,
  Double: 3,
  Date: 4,
  Time: 5,
  DateTime: 6,
  Url: 7,
  Email: 8,
  Textarea: 9,
  Select: 10,
  IpAddress: 11,
} as const;

export interface ObjectTypeAttribute {
  id: string;
  name: string;
  description?: string;
  label?: boolean;
  type: number;
  defaultType?: { id: number; name: string };
  typeValue?: string;
  typeValueMulti?: string[];
  referenceObjectTypeId?: string;
  referenceObjectType?: ObjectType;
  editable?: boolean;
  system?: boolean;
  hidden?: boolean;
  sortable?: boolean;
  minimumCardinality?: number;
  maximumCardinality?: number;
  suffix?: string;
  options?: string;
  position?: number;
}

/** Status.category: 0 inactive (red), 1 active (green), 2 pending (yellow). */
export interface StatusType {
  id: string;
  name: string;
  description?: string;
  category: number;
  objectSchemaId?: string | null;
}

export interface ReferencedObject {
  id: string;
  objectKey: string;
  label: string;
  objectType?: ObjectType;
}

export interface AssetsUser {
  avatarUrl?: string;
  displayName?: string;
  name?: string;
  key?: string;
  emailAddress?: string;
}

export interface ObjectAttributeValue {
  value?: string;
  displayValue?: string;
  searchValue?: string;
  referencedType?: boolean;
  referencedObject?: ReferencedObject;
  user?: AssetsUser;
  group?: { name: string };
  status?: StatusType;
}

export interface ObjectAttribute {
  id?: string;
  objectTypeAttributeId: string;
  objectTypeAttribute?: ObjectTypeAttribute;
  objectAttributeValues: ObjectAttributeValue[];
}

export interface AssetObject {
  id: string;
  objectKey: string;
  label: string;
  objectType: ObjectType;
  created: string;
  updated: string;
  attributes: ObjectAttribute[];
}

export interface AqlResult extends PagedResult<AssetObject> {
  objectTypeAttributes?: ObjectTypeAttribute[];
}

export interface ObjectHistory {
  id: string;
  actor?: AssetsUser;
  affectedAttribute?: string;
  oldValue?: string;
  newValue?: string;
  type?: number;
  created: string;
}

export interface ReferenceTypeInfo {
  referenceTypes: { id: string; name: string; color?: string }[];
  objectType: ObjectType;
  numberOfReferencedObjects: number;
}

export interface ObjectAttributeIn {
  objectTypeAttributeId: string;
  objectAttributeValues: { value: string }[];
}

export interface ObjectIn {
  objectTypeId: string;
  attributes: ObjectAttributeIn[];
}

export interface ConnectionInfo {
  siteUrl: string;
  email: string;
  cloudId: string;
  workspaceId: string;
}
