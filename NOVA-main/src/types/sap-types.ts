// SAP Types
export interface ODataService {
    id: string;
    version: string;
    title: string;
    description: string;
    odataVersion: 'v2' | 'v4';
    url: string;
    metadataUrl: string;
    entitySets: string[];
    metadata: ServiceMetadata | null;
    
    // Domain/Tier classification (added in v2 for tiered discovery)
    /** Business domain: 'AR', 'AP', 'GL', 'SD', etc. Null if unclassified */
    domain?: string | null;
    /** Service tier: 1=Transactional, 2=Display, 3=Analytics, 0=Unclassified */
    tier?: number;
    /** Priority score for ranking (lower = higher priority) */
    priority?: number;
    /** Whether this is a priority service that should always appear first */
    isPriorityService?: boolean;
}

export interface ServiceMetadata {
    entityTypes: EntityType[];
    entitySets: Array<{ [key: string]: string | boolean | null }>;
    version: string;
    namespace: string;
}

export interface EntityType {
    name: string;
    entitySet: string | null | undefined;
    namespace: string;
    properties: Property[];
    navigationProperties: NavigationProperty[];
    keys: string[];
    creatable: boolean;
    updatable: boolean;
    deletable: boolean;
    addressable: boolean;
}

export interface Property {
    name: string;
    type: string;
    nullable: boolean;
    maxLength?: string;
}

export interface NavigationProperty {
    name: string;
    type: string;
    multiplicity: '1' | '0..1' | '*';
}
