/**
 * SAP OData Service Discovery
 * 
 * V2 Architecture: Lightweight catalog discovery + lazy metadata loading
 * 
 * - discoverCatalog(): Fast startup - fetches all services without metadata
 * - fetchServiceMetadata(): On-demand metadata loading (called by tool registry)
 * 
 * Services are tagged with domain/tier classification at discovery time
 * for intelligent ranking in search results.
 */

import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { SAPClient } from './sap-client.js';
import { Logger } from '../utils/logger.js';
import { ODataService, EntityType, ServiceMetadata } from '../types/sap-types.js';
import { classifyService, isExcludedService } from '../config/domain-tier-config.js';
import { JSDOM } from 'jsdom';

export class SAPDiscoveryService {
    constructor(
        private sapClient: SAPClient,
        private logger: Logger
    ) { }

    /**
     * Discover all SAP OData services from the catalog (lightweight, no metadata)
     * 
     * This is the primary discovery method for V2 architecture.
     * Returns all services tagged with domain/tier classification.
     * Metadata is NOT fetched here - use fetchServiceMetadata() on demand.
     * 
     * @returns Array of ODataService objects with domain/tier tags, but no metadata
     */
    async discoverCatalog(): Promise<ODataService[]> {
        try {
            this.logger.info('Discovering SAP OData service catalog (lightweight)...');
            const startTime = Date.now();

            // Fetch from V2 catalog (most common)
            const services = await this.discoverV2Services();
            
            // Tag each service with domain/tier classification
            const taggedServices = services.map(service => {
                const classification = classifyService(service.id, service.title);
                return {
                    ...service,
                    domain: classification.domain,
                    tier: classification.tier,
                    priority: classification.priority,
                    isPriorityService: classification.isPriorityService,
                };
            });

            // Filter out explicitly excluded services (false positives like RAR_*)
            const filteredServices = taggedServices.filter(
                service => !isExcludedService(service.id)
            );

            const elapsed = Date.now() - startTime;
            const domainCounts = this.countByDomain(filteredServices);
            
            this.logger.info(`Discovered ${filteredServices.length} services in ${elapsed}ms`);
            this.logger.info('Services by domain:', domainCounts);

            return filteredServices;

        } catch (error) {
            this.logger.error('Service catalog discovery failed:', error);
            throw error;
        }
    }

    /**
     * Fetch metadata for a specific service (on-demand, for lazy loading)
     * 
     * Called by the tool registry when metadata is needed.
     * Result should be cached by the caller.
     * 
     * @param service - The service to fetch metadata for
     * @returns ServiceMetadata with entity types, properties, keys, etc.
     */
    async fetchServiceMetadata(service: ODataService): Promise<ServiceMetadata> {
        try {
            this.logger.debug(`Fetching metadata for service: ${service.id}`);
            const startTime = Date.now();

            const destination = await this.sapClient.getDestination();
            const response = await executeHttpRequest(destination, {
                method: 'GET',
                url: service.metadataUrl,
                headers: {
                    'Accept': 'application/xml'
                }
            });

            const metadata = this.parseMetadata(response.data, service.odataVersion);
            const elapsed = Date.now() - startTime;
            
            this.logger.debug(`Metadata for ${service.id}: ${metadata.entityTypes.length} entities in ${elapsed}ms`);
            return metadata;

        } catch (error) {
            this.logger.error(`Failed to fetch metadata for service ${service.id}:`, error);
            throw error;
        }
    }

    /**
     * Count services by domain for logging
     */
    private countByDomain(services: ODataService[]): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const service of services) {
            const domain = service.domain || 'unclassified';
            counts[domain] = (counts[domain] || 0) + 1;
        }
        return counts;
    }

    /**
     * Discover services from V2 catalog
     */
    private async discoverV2Services(): Promise<ODataService[]> {
        try {
            const destination = await this.sapClient.getDestination();

            const response = await executeHttpRequest(destination, {
                method: 'GET',
                url: '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection',
                headers: {
                    'Accept': 'application/json'
                }
            });

            return this.parseV2CatalogResponse(response.data);

        } catch (error) {
            this.logger.error('V2 service discovery failed:', error);
            return [];
        }
    }

    /**
     * Parse V2 catalog response
     */
    private parseV2CatalogResponse(catalogData: unknown): ODataService[] {
        interface V2Service {
            ID: string;
            TechnicalServiceVersion?: string;
            Title?: string;
            Description?: string;
            ServiceUrl: string;
            TechnicalServiceName: string;
        }
        
        const services: ODataService[] = [];
        const results = (catalogData as { d?: { results?: V2Service[] } }).d?.results;
        
        if (results) {
            results.forEach((service) => {
                const baseURL = `/sap/opu/odata/${service.ServiceUrl.split("/sap/opu/odata/")[1]}${service.TechnicalServiceName.includes("TASKPROCESSING") && Number(service.TechnicalServiceVersion) > 1 ? `;mo` : ``}/`;
                services.push({
                    id: service.ID,
                    version: service.TechnicalServiceVersion || '0001',
                    title: service.Title || service.ID,
                    description: service.Description || `OData service ${service.ID}`,
                    odataVersion: 'v2',
                    url: baseURL,
                    metadataUrl: `${baseURL}$metadata`,
                    entitySets: [],
                    metadata: null,
                });
            });
        }
        
        return services;
    }

    /**
     * Parse metadata XML into structured format
     */
    private parseMetadata(metadataXml: string, odataVersion: string): ServiceMetadata {
        const dom = new JSDOM(metadataXml);
        const xmlDoc = dom.window.document;

        const entitySets = this.extractEntitySets(xmlDoc);
        const entityTypes = this.extractEntityTypes(xmlDoc, entitySets);

        return {
            entityTypes,
            entitySets,
            version: odataVersion,
            namespace: this.extractNamespace(xmlDoc)
        };
    }

    /**
     * Extract entity types from metadata XML
     */
    private extractEntityTypes(
        xmlDoc: Document, 
        entitySets: Array<{ [key: string]: string | boolean | null }>
    ): EntityType[] {
        const entityTypes: EntityType[] = [];
        const nodes = xmlDoc.querySelectorAll("EntityType");

        nodes.forEach((node: Element) => {
            const entitySet = entitySets.find(
                es => (es.entitytype as string)?.split(".")[1] === node.getAttribute("Name")
            );
            
            const entityType: EntityType = {
                name: node.getAttribute("Name") || '',
                namespace: node.parentElement?.getAttribute("Namespace") || '',
                entitySet: entitySet?.name as string,
                creatable: !!entitySet?.creatable,
                updatable: !!entitySet?.updatable,
                deletable: !!entitySet?.deletable,
                addressable: !!entitySet?.addressable,
                properties: [],
                navigationProperties: [],
                keys: []
            };

            // Extract properties
            const propNodes = node.querySelectorAll("Property");
            propNodes.forEach((propNode: Element) => {
                entityType.properties.push({
                    name: propNode.getAttribute("Name") || '',
                    type: propNode.getAttribute("Type") || '',
                    nullable: propNode.getAttribute("Nullable") !== "false",
                    maxLength: propNode.getAttribute("MaxLength") ?? undefined
                });
            });

            // Extract keys
            const keyNodes = node.querySelectorAll("Key PropertyRef");
            keyNodes.forEach((keyNode: Element) => {
                entityType.keys.push(keyNode.getAttribute("Name") || '');
            });

            entityTypes.push(entityType);
        });

        return entityTypes;
    }

    /**
     * Extract entity sets from metadata XML
     */
    private extractEntitySets(xmlDoc: Document): Array<{ [key: string]: string | boolean | null }> {
        const entitySets: Array<{ [key: string]: string | boolean | null }> = [];
        const nodes = xmlDoc.querySelectorAll("EntitySet");

        nodes.forEach((node: Element) => {
            const entityset: { [key: string]: string | boolean | null } = {};
            
            ['name', 'entitytype', 'sap:creatable', 'sap:updatable', 'sap:deletable', 'sap:pageable', 'sap:addressable', 'sap:content-version'].forEach(attr => {
                const [namespace, name] = attr.split(":");
                entityset[name || namespace] = node.getAttribute(attr);
            });
            
            ['sap:creatable', 'sap:updatable', 'sap:deletable', 'sap:pageable', 'sap:addressable'].forEach(attr => {
                const [, name] = attr.split(":");
                entityset[name] = node.getAttribute(attr) === "false" ? false : true;
            });
            
            if (entityset.name) {
                entitySets.push(entityset);
            }
        });

        return entitySets;
    }

    /**
     * Extract namespace from metadata XML
     */
    private extractNamespace(xmlDoc: Document): string {
        const schemaNode = xmlDoc.querySelector("Schema");
        return schemaNode?.getAttribute("Namespace") || '';
    }
}

