/**
 * Hierarchical Tool Registry V2 - Tiered Discovery with Lazy Metadata Loading
 * 
 * Architecture:
 *   Level 1: discover-sap-data - Search ALL services, ranked by domain/tier
 *   Level 2: get-entity-metadata - Lazy load metadata on demand (cached)
 *   Level 3: execute-sap-operation - Execute CRUD with user context
 * 
 * Key V2 Features:
 *   - All services discoverable (no MAX_SERVICES cap)
 *   - Tier-based ranking (Tier 1 transactional services first)
 *   - Lazy metadata loading (fast startup, on-demand fetch)
 *   - Metadata caching (fetch once, reuse)
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SAPClient } from "../services/sap-client.js";
import { SAPDiscoveryService } from "../services/sap-discovery.js";
import { Logger } from "../utils/logger.js";
import { ODataService, EntityType, ServiceMetadata } from "../types/sap-types.js";
import { EmbeddingService, SearchResult } from "../services/embedding-service.js";
import { getDomainDisplayName, getServiceHint } from "../config/domain-tier-config.js";
import { z } from "zod";

export class HierarchicalSAPToolRegistry {
    private userToken?: string;
    private embeddingService?: EmbeddingService;
    
    // V2: Metadata cache for lazy loading
    private metadataCache = new Map<string, ServiceMetadata>();

    constructor(
        private mcpServer: McpServer,
        private sapClient: SAPClient,
        private logger: Logger,
        private catalogServices: ODataService[],
        private discoveryService: SAPDiscoveryService,
        embeddingService?: EmbeddingService
    ) {
        this.embeddingService = embeddingService;
        this.logServiceStats();
    }

    /**
     * Log service statistics by domain and tier
     */
    private logServiceStats(): void {
        const stats: Record<string, Record<number, number>> = {};
        
        for (const service of this.catalogServices) {
            const domain = service.domain || 'unclassified';
            const tier = service.tier || 0;
            
            if (!stats[domain]) stats[domain] = {};
            stats[domain][tier] = (stats[domain][tier] || 0) + 1;
        }
        
        this.logger.info(`📊 Service catalog: ${this.catalogServices.length} total services`);
        for (const [domain, tiers] of Object.entries(stats)) {
            const tierStr = Object.entries(tiers)
                .map(([t, c]) => `T${t}:${c}`)
                .join(', ');
            this.logger.info(`   ${domain}: ${tierStr}`);
        }
    }

    /**
     * Set embedding service for semantic search
     */
    setEmbeddingService(embeddingService: EmbeddingService): void {
        this.embeddingService = embeddingService;
        if (embeddingService.isReady()) {
            this.logger.info(`🧠 Semantic search enabled`);
        }
    }

    /**
     * Set user JWT token for authenticated operations
     */
    setUserToken(token?: string): void {
        this.userToken = token;
        this.sapClient.setUserToken(token);
        this.logger.debug(`User token ${token ? 'set' : 'cleared'}`);
    }

    /**
     * Register the 3-level discovery tools
     */
    public async registerDiscoveryTools(): Promise<void> {
        this.logger.info(`🔧 Registering 3-level discovery tools for ${this.catalogServices.length} services`);

        // Level 1: Lightweight discovery with tier-based ranking
        this.mcpServer.registerTool(
            "discover-sap-data",
            {
                title: "Level 1: Discover SAP Services and Entities",
                description: "[LEVEL 1 - DISCOVERY] Search for SAP services and entities. Returns services ranked by relevance and tier (transactional services first). Use get-entity-metadata (Level 2) to get full schema details for your selected entity.",
                inputSchema: {
                    query: z.string().optional().describe("Search term (e.g., 'customer', 'invoice', 'payment'). If empty, returns all services."),
                    domain: z.string().optional().describe("Filter by domain: AR, SD, FI, or 'all'. Default: all"),
                    limit: z.number().min(1).max(100).optional().describe("Max results. Default: 20")
                }
            },
            async (args: Record<string, unknown>) => {
                return this.discoverServicesAndEntities(args);
            }
        );

        // Level 2: Lazy-loaded entity metadata
        this.mcpServer.registerTool(
            "get-entity-metadata",
            {
                title: "Level 2: Get Entity Metadata",
                description: "[LEVEL 2 - METADATA] Get complete schema for a specific entity. Returns all properties, types, keys, and capabilities. Metadata is fetched on-demand and cached.",
                inputSchema: {
                    serviceId: z.string().describe("Service ID from discover-sap-data results"),
                    entityName: z.string().describe("Entity name from discover-sap-data results")
                }
            },
            async (args: Record<string, unknown>) => {
                return this.getEntityMetadata(args);
            }
        );

        // Level 3: Execute operations
        this.mcpServer.registerTool(
            "execute-sap-operation",
            {
                title: "Level 3: Execute SAP Operation",
                description: "[LEVEL 3 - EXECUTION] Perform CRUD operations on SAP entities. Requires authentication for data operations.",
                inputSchema: {
                    serviceId: z.string().describe("Service ID"),
                    entityName: z.string().describe("Entity name"),
                    operation: z.string().describe("Operation: read, read-single, create, update, delete"),
                    parameters: z.record(z.any()).optional().describe("Key/data parameters"),
                    filterString: z.string().optional().describe("OData $filter value"),
                    selectString: z.string().optional().describe("OData $select value"),
                    expandString: z.string().optional().describe("OData $expand value"),
                    orderbyString: z.string().optional().describe("OData $orderby value"),
                    topNumber: z.number().optional().describe("OData $top value"),
                    skipNumber: z.number().optional().describe("OData $skip value")
                }
            },
            async (args: Record<string, unknown>) => {
                return this.executeOperation(args);
            }
        );

        this.logger.info("✅ Registered 3-level discovery tools");
    }

    /**
     * Level 1: Discover services with hybrid search (Vector + Pattern) and tier reranking
     * 
     * Search Strategy:
     * 1. If embedding service ready: Use vector/semantic search
     * 2. Apply tier reranking to results
     * 3. If vector returns 0 results: Fall back to pattern matching
     * 4. If no query: Return all services sorted by tier
     */
    private async discoverServicesAndEntities(args: Record<string, unknown>) {
        try {
            const query = (args.query as string)?.trim() || "";
            const queryLower = query.toLowerCase();
            const domainFilter = (args.domain as string)?.toUpperCase() || "ALL";
            const limit = (args.limit as number) || 20;

            // Filter by domain if specified
            let services = this.catalogServices;
            if (domainFilter !== "ALL") {
                services = services.filter(s => s.domain === domainFilter);
            }

            let scoredServices: Array<{
                service: ODataService;
                score: number;
                matchReason: string;
            }> = [];
            
            let searchMethod = "none";

            if (query) {
                // === HYBRID SEARCH: Vector primary, Pattern fallback ===
                
                // Try vector/semantic search first
                if (this.embeddingService?.isReady()) {
                    try {
                        this.logger.debug(`🧠 Trying semantic search for: "${query}"`);
                        const semanticResults = await this.embeddingService.searchServices(query, limit * 2, 0.25);
                        
                        if (semanticResults.length > 0) {
                            searchMethod = "semantic";
                            // Convert semantic results to scored services
                            for (const result of semanticResults) {
                                const service = services.find(s => s.id === result.metadata.serviceId);
                                if (service) {
                                    scoredServices.push({
                                        service,
                                        score: result.score,
                                        matchReason: `Semantic match (${(result.score * 100).toFixed(0)}%)`
                                    });
                                }
                            }
                            this.logger.debug(`Semantic search found ${scoredServices.length} matches`);
                        }
                    } catch (semanticError) {
                        this.logger.warn('Semantic search failed, falling back to pattern:', semanticError);
                    }
                }

                // Fall back to pattern matching if semantic returned nothing
                if (scoredServices.length === 0) {
                    searchMethod = "pattern";
                    scoredServices = this.patternSearch(services, queryLower);
                    this.logger.debug(`Pattern search found ${scoredServices.length} matches`);
                }
            }
            
            // If still no results or no query, return all services
            if (scoredServices.length === 0) {
                searchMethod = query ? "fallback" : "all";
                scoredServices = services.map(service => ({
                    service,
                    score: 0.5,
                    matchReason: "All services"
                }));
            }

            // Sort by: (1) Tier (ascending), (2) Priority (ascending), (3) Score (descending)
            scoredServices.sort((a, b) => {
                // Priority services first
                if (a.service.isPriorityService !== b.service.isPriorityService) {
                    return a.service.isPriorityService ? -1 : 1;
                }
                // Then by tier
                const tierA = a.service.tier || 99;
                const tierB = b.service.tier || 99;
                if (tierA !== tierB) return tierA - tierB;
                // Then by priority score
                const prioA = a.service.priority || 100;
                const prioB = b.service.priority || 100;
                if (prioA !== prioB) return prioA - prioB;
                // Finally by search score
                return b.score - a.score;
            });

            // Apply limit
            const totalFound = scoredServices.length;
            const limitedResults = scoredServices.slice(0, limit);

            // Build response with hints for LLM guidance
            const results = limitedResults.map(item => {
                const hint = getServiceHint(item.service.id);
                return {
                    serviceId: item.service.id,
                    // Use hint label if available, otherwise SAP catalog title
                    serviceName: hint?.label || item.service.title,
                    // Include useFor hint to guide LLM selection
                    useFor: hint?.useFor || item.service.description,
                    // Include key entities if available
                    keyEntities: hint?.entities,
                    // SAP transaction code equivalent
                    tcode: hint?.tcode,
                    domain: item.service.domain,
                    domainName: getDomainDisplayName(item.service.domain || null),
                    tier: item.service.tier,
                    tierLabel: this.getTierLabel(item.service.tier),
                    isPriority: item.service.isPriorityService,
                    matchReason: item.matchReason,
                    hasMetadata: !!item.service.metadata
                };
            });

            const response = {
                query: query || "(all)",
                domain: domainFilter,
                searchMethod,
                totalFound,
                showing: results.length,
                results
            };

            let text = `[LEVEL 1 - DISCOVERY] `;
            const methodLabel = searchMethod === "semantic" ? "🧠 Semantic" : 
                               searchMethod === "pattern" ? "📝 Pattern" : 
                               searchMethod === "fallback" ? "📋 All (no matches)" : "📋 All";
            if (query) {
                text += `${methodLabel} search found ${totalFound} services for "${query}"`;
            } else {
                text += `Showing ${results.length} of ${totalFound} services`;
            }
            if (domainFilter !== "ALL") {
                text += ` in domain ${domainFilter}`;
            }
            text += `\n\n`;
            text += `NEXT: Call get-entity-metadata with serviceId and entityName to get full schema.\n\n`;
            text += `Note: Services ranked by tier (Tier 1 transactional first). Priority services always first.\n\n`;
            text += JSON.stringify(response, null, 2);

            return {
                content: [{ type: "text" as const, text }]
            };

        } catch (error) {
            this.logger.error('Error in Level 1 discovery:', error);
            return {
                content: [{ type: "text" as const, text: `ERROR: ${error}` }],
                isError: true
            };
        }
    }

    /**
     * Get tier label for display
     */
    private getTierLabel(tier: number | undefined): string {
        switch (tier) {
            case 1: return "Tier 1 (Transactional)";
            case 2: return "Tier 2 (Display)";
            case 3: return "Tier 3 (Analytics)";
            default: return "Unclassified";
        }
    }

    /**
     * Pattern-based search (fallback when semantic search unavailable or returns no results)
     * Searches service ID, title, description, and hints
     */
    private patternSearch(
        services: ODataService[], 
        queryLower: string
    ): Array<{ service: ODataService; score: number; matchReason: string }> {
        const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
        
        return services
            .map(service => {
                const hint = getServiceHint(service.id);
                
                // Search targets (SAP catalog + our hints)
                const searchTargets = [
                    { text: service.id.toLowerCase(), weight: 0.9, name: "ID" },
                    { text: service.title.toLowerCase(), weight: 0.85, name: "Title" },
                    { text: service.description.toLowerCase(), weight: 0.6, name: "Description" },
                    { text: hint?.label?.toLowerCase() || "", weight: 0.95, name: "Label" },
                    { text: hint?.useFor?.toLowerCase() || "", weight: 0.9, name: "UseFor" },
                    { text: hint?.tcode?.toLowerCase() || "", weight: 0.85, name: "TCode" },
                    { text: hint?.entities?.join(" ").toLowerCase() || "", weight: 0.8, name: "Entities" },
                ];
                
                let bestScore = 0;
                let matchReason = "";
                
                for (const target of searchTargets) {
                    if (!target.text) continue;
                    
                    // Full query match
                    if (target.text.includes(queryLower)) {
                        if (target.weight > bestScore) {
                            bestScore = target.weight;
                            matchReason = `${target.name} match`;
                        }
                    }
                    // Multi-word: check if ALL words match
                    else if (queryWords.length > 1) {
                        const allWordsMatch = queryWords.every(word => target.text.includes(word));
                        if (allWordsMatch && target.weight * 0.9 > bestScore) {
                            bestScore = target.weight * 0.9;
                            matchReason = `${target.name} (all words)`;
                        }
                    }
                    // Single word partial match
                    else if (queryWords.length === 1 && target.text.includes(queryWords[0])) {
                        if (target.weight * 0.85 > bestScore) {
                            bestScore = target.weight * 0.85;
                            matchReason = `${target.name} (partial)`;
                        }
                    }
                }
                
                return { service, score: bestScore, matchReason };
            })
            .filter(item => item.score > 0);
    }

    /**
     * Level 2: Get entity metadata with lazy loading
     */
    private async getEntityMetadata(args: Record<string, unknown>) {
        try {
            const serviceId = args.serviceId as string;
            const entityName = args.entityName as string;

            if (!serviceId || !entityName) {
                return {
                    content: [{ 
                        type: "text" as const, 
                        text: `ERROR: Both serviceId and entityName are required.` 
                    }],
                    isError: true
                };
            }

            // Find the service
            const service = this.catalogServices.find(s => s.id === serviceId);
            if (!service) {
                return {
                    content: [{ 
                        type: "text" as const, 
                        text: `ERROR: Service not found: ${serviceId}` 
                    }],
                    isError: true
                };
            }

            // Lazy load metadata if not cached
            if (!service.metadata) {
                if (this.metadataCache.has(serviceId)) {
                    service.metadata = this.metadataCache.get(serviceId)!;
                    this.logger.debug(`Using cached metadata for ${serviceId}`);
                } else {
                    this.logger.info(`Lazy loading metadata for ${serviceId}...`);
                    try {
                        service.metadata = await this.discoveryService.fetchServiceMetadata(service);
                        this.metadataCache.set(serviceId, service.metadata);
                        this.logger.info(`Loaded and cached metadata for ${serviceId}`);
                    } catch (fetchError) {
                        return {
                            content: [{ 
                                type: "text" as const, 
                                text: `ERROR: Failed to load metadata for ${serviceId}: ${fetchError}` 
                            }],
                            isError: true
                        };
                    }
                }
            }

            // Find the entity
            const entityType = service.metadata?.entityTypes?.find(e => e.name === entityName);
            if (!entityType) {
                const available = service.metadata?.entityTypes?.map(e => e.name).join(', ') || 'none';
                return {
                    content: [{ 
                        type: "text" as const, 
                        text: `ERROR: Entity '${entityName}' not found in ${serviceId}.\n\nAvailable entities: ${available}` 
                    }],
                    isError: true
                };
            }

            // Build response
            const metadata = {
                service: {
                    id: service.id,
                    title: service.title,
                    domain: service.domain,
                    tier: service.tier
                },
                entity: {
                    name: entityType.name,
                    entitySet: entityType.entitySet,
                    namespace: entityType.namespace,
                    keyProperties: entityType.keys,
                    propertyCount: entityType.properties.length
                },
                capabilities: {
                    readable: true,
                    creatable: entityType.creatable,
                    updatable: entityType.updatable,
                    deletable: entityType.deletable
                },
                properties: entityType.properties.map(prop => ({
                    name: prop.name,
                    type: prop.type,
                    nullable: prop.nullable,
                    maxLength: prop.maxLength,
                    isKey: entityType.keys.includes(prop.name)
                }))
            };

            let text = `[LEVEL 2 - METADATA] Schema for ${entityName} in ${service.title}\n\n`;
            text += `NEXT: Use execute-sap-operation with:\n`;
            text += `  serviceId: "${serviceId}"\n`;
            text += `  entityName: "${entityName}"\n`;
            text += `  operation: read | read-single | create | update | delete\n\n`;
            text += `Keys: [${entityType.keys.join(', ')}]\n`;
            text += `Capabilities: read=✓, create=${entityType.creatable ? '✓' : '✗'}, update=${entityType.updatable ? '✓' : '✗'}, delete=${entityType.deletable ? '✓' : '✗'}\n\n`;
            text += JSON.stringify(metadata, null, 2);

            return {
                content: [{ type: "text" as const, text }]
            };

        } catch (error) {
            this.logger.error('Error in Level 2 metadata:', error);
            return {
                content: [{ type: "text" as const, text: `ERROR: ${error}` }],
                isError: true
            };
        }
    }

    /**
     * Level 3: Execute CRUD operations
     */
    private async executeOperation(args: Record<string, unknown>) {
        try {
            const serviceId = args.serviceId as string;
            const entityName = args.entityName as string;
            const operation = (args.operation as string)?.toLowerCase();
            const parameters = args.parameters as Record<string, unknown> || {};

            // Validate
            const validOps = ["read", "read-single", "create", "update", "delete"];
            if (!validOps.includes(operation)) {
                throw new Error(`Invalid operation: ${operation}. Valid: ${validOps.join(', ')}`);
            }

            // Find service
            const service = this.catalogServices.find(s => s.id === serviceId);
            if (!service) {
                throw new Error(`Service not found: ${serviceId}`);
            }

            // Ensure metadata is loaded
            if (!service.metadata) {
                if (this.metadataCache.has(serviceId)) {
                    service.metadata = this.metadataCache.get(serviceId)!;
                } else {
                    service.metadata = await this.discoveryService.fetchServiceMetadata(service);
                    this.metadataCache.set(serviceId, service.metadata);
                }
            }

            // Find entity
            const entityType = service.metadata?.entityTypes?.find(e => e.name === entityName);
            if (!entityType) {
                throw new Error(`Entity '${entityName}' not found in ${serviceId}`);
            }

            // Build query options
            const queryOptions: Record<string, unknown> = {};
            if (args.filterString) queryOptions.$filter = args.filterString;
            if (args.selectString) queryOptions.$select = args.selectString;
            if (args.expandString) queryOptions.$expand = args.expandString;
            if (args.orderbyString) queryOptions.$orderby = args.orderbyString;
            if (args.topNumber) queryOptions.$top = args.topNumber;
            if (args.skipNumber) queryOptions.$skip = args.skipNumber;

            // Set user token if available
            if (this.userToken) {
                this.sapClient.setUserToken(this.userToken);
            }

            // Execute operation
            let response: { data: unknown } = { data: null };
            let opDescription = "";

            switch (operation) {
                case 'read':
                    opDescription = `Reading ${entityName}`;
                    if (queryOptions.$top) opDescription += ` (top ${queryOptions.$top})`;
                    if (queryOptions.$filter) opDescription += ` where ${queryOptions.$filter}`;
                    response = await this.sapClient.readEntitySet(
                        service.url, 
                        entityType.entitySet!, 
                        queryOptions, 
                        false
                    );
                    break;

                case 'read-single': {
                    const keyValue = this.buildKeyValue(entityType, parameters);
                    opDescription = `Reading single ${entityName} with key: ${keyValue}`;
                    response = await this.sapClient.readEntity(
                        service.url, 
                        entityType.entitySet!, 
                        keyValue, 
                        false
                    );
                    break;
                }

                case 'create':
                    if (!entityType.creatable) {
                        throw new Error(`Entity '${entityName}' is not creatable`);
                    }
                    opDescription = `Creating ${entityName}`;
                    response = await this.sapClient.createEntity(
                        service.url, 
                        entityType.entitySet!, 
                        parameters
                    );
                    break;

                case 'update': {
                    if (!entityType.updatable) {
                        throw new Error(`Entity '${entityName}' is not updatable`);
                    }
                    const updateKey = this.buildKeyValue(entityType, parameters);
                    const updateData = { ...parameters };
                    entityType.keys.forEach(key => delete updateData[key]);
                    opDescription = `Updating ${entityName} with key: ${updateKey}`;
                    response = await this.sapClient.updateEntity(
                        service.url, 
                        entityType.entitySet!, 
                        updateKey, 
                        updateData
                    );
                    break;
                }

                case 'delete': {
                    if (!entityType.deletable) {
                        throw new Error(`Entity '${entityName}' is not deletable`);
                    }
                    const deleteKey = this.buildKeyValue(entityType, parameters);
                    opDescription = `Deleting ${entityName} with key: ${deleteKey}`;
                    await this.sapClient.deleteEntity(
                        service.url, 
                        entityType.entitySet!, 
                        deleteKey
                    );
                    response = { data: { success: true, message: `Deleted ${entityName}: ${deleteKey}` } };
                    break;
                }
            }

            let text = `[LEVEL 3 - SUCCESS] ${opDescription}\n\n`;
            text += JSON.stringify(response.data, null, 2);

            return {
                content: [{ type: "text" as const, text }]
            };

        } catch (error) {
            this.logger.error('Error in Level 3 execution:', error);
            const errorMsg = error instanceof Error ? error.message : String(error);
            
            let text = `[LEVEL 3 - ERROR] ${errorMsg}\n\n`;
            
            // Check if $select related error
            if (args.selectString && errorMsg.toLowerCase().includes('select')) {
                text += `TIP: This might be a $select issue. Try again without selectString.\n`;
            }

            return {
                content: [{ type: "text" as const, text }],
                isError: true
            };
        }
    }

    /**
     * Build key value for entity operations
     */
    private buildKeyValue(entityType: EntityType, parameters: Record<string, unknown>): string {
        const keys = entityType.keys;

        if (keys.length === 1) {
            const keyName = keys[0];
            if (!(keyName in parameters)) {
                throw new Error(`Missing key: ${keyName}`);
            }
            return String(parameters[keyName]);
        }

        // Composite key
        const parts = keys.map(key => {
            if (!(key in parameters)) {
                throw new Error(`Missing key: ${key}`);
            }
            return `${key}='${parameters[key]}'`;
        });
        return parts.join(',');
    }

    /**
     * Register MCP resources
     */
    public registerServiceMetadataResources(): void {
        // Service list resource
        this.mcpServer.registerResource(
            "sap-services",
            "sap://services",
            {
                title: "Available SAP Services",
                description: "List of all discovered SAP OData services with domain/tier classification",
                mimeType: "application/json"
            },
            async (uri) => ({
                contents: [{
                    uri: uri.href,
                    text: JSON.stringify({
                        totalServices: this.catalogServices.length,
                        byDomain: this.getServicesByDomain(),
                        services: this.catalogServices.map(s => ({
                            id: s.id,
                            title: s.title,
                            domain: s.domain,
                            tier: s.tier,
                            isPriority: s.isPriorityService
                        }))
                    }, null, 2)
                }]
            })
        );

        // Service metadata resource template
        this.mcpServer.registerResource(
            "sap-service-metadata",
            new ResourceTemplate("sap://service/{serviceId}/metadata", { list: undefined }),
            {
                title: "SAP Service Metadata",
                description: "Metadata for a specific SAP OData service"
            },
            async (uri, variables) => {
                const serviceId = typeof variables.serviceId === "string" ? variables.serviceId : "";
                const service = this.catalogServices.find(s => s.id === serviceId);
                
                if (!service) {
                    throw new Error(`Service not found: ${serviceId}`);
                }

                // Lazy load if needed
                if (!service.metadata && !this.metadataCache.has(serviceId)) {
                    service.metadata = await this.discoveryService.fetchServiceMetadata(service);
                    this.metadataCache.set(serviceId, service.metadata);
                } else if (!service.metadata) {
                    service.metadata = this.metadataCache.get(serviceId)!;
                }

                return {
                    contents: [{
                        uri: uri.href,
                        text: JSON.stringify({
                            service: {
                                id: service.id,
                                title: service.title,
                                domain: service.domain,
                                tier: service.tier
                            },
                            entities: service.metadata?.entityTypes?.map(e => ({
                                name: e.name,
                                entitySet: e.entitySet,
                                keys: e.keys,
                                propertyCount: e.properties.length,
                                capabilities: {
                                    creatable: e.creatable,
                                    updatable: e.updatable,
                                    deletable: e.deletable
                                }
                            })) || []
                        }, null, 2),
                        mimeType: "application/json"
                    }]
                };
            }
        );

        // System instructions resource
        this.mcpServer.registerResource(
            "system-instructions",
            "sap://system/instructions",
            {
                title: "SAP MCP Server Instructions",
                description: "Instructions for AI assistants",
                mimeType: "text/markdown"
            },
            async (uri) => ({
                contents: [{
                    uri: uri.href,
                    text: this.getSystemInstructions(),
                    mimeType: "text/markdown"
                }]
            })
        );
    }

    /**
     * Get services grouped by domain
     */
    private getServicesByDomain(): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const service of this.catalogServices) {
            const domain = service.domain || 'unclassified';
            counts[domain] = (counts[domain] || 0) + 1;
        }
        return counts;
    }

    /**
     * System instructions for AI assistants
     */
    private getSystemInstructions(): string {
        return `# SAP OData MCP Server V2 - Tiered Discovery

## 3-Level Architecture

### Level 1: discover-sap-data
- Search all ${this.catalogServices.length} services
- Results ranked by tier (Tier 1 transactional first)
- Returns: serviceId, serviceName, domain, tier
- Use this to find relevant services

### Level 2: get-entity-metadata  
- Get full schema for selected service/entity
- Metadata loaded on-demand and cached
- Returns: properties, types, keys, capabilities
- Use after Level 1 to get details

### Level 3: execute-sap-operation
- Perform CRUD operations
- Uses schema from Level 2
- Requires authentication for data access

## Tier System

Services are classified into tiers:
- **Tier 1 (Transactional)**: Services for CRUD operations (MANAGE, CREATE, POST)
- **Tier 2 (Display)**: Read-only services (DISPLAY, HISTORY, LIST)  
- **Tier 3 (Analytics)**: Dashboard/KPI services (_CDS, _OVP_)

Priority services (like ZFAR_CUSTOMER_LINE_ITEMS) always appear first.

## Workflow

1. discover-sap-data → Find service/entity
2. get-entity-metadata → Get schema (lazy loaded)
3. execute-sap-operation → Execute CRUD

## Tips

- Start with broad queries, then narrow down
- Check entity capabilities before create/update/delete
- Use OData filters to limit results
- If $select fails, retry without it
`;
    }
}
