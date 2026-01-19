/**
 * Embedding Service for Semantic Search
 * 
 * Uses @xenova/transformers with all-MiniLM-L6-v2 model (384 dimensions, ~80MB)
 * to provide vector-based semantic search for SAP OData entities.
 * 
 * Features:
 * - Local embedding generation (no external API calls)
 * - In-memory vector store with cosine similarity search
 * - JSON file caching to avoid re-embedding on startup
 * - Skip patterns for non-business entities
 */

import { pipeline, Pipeline, env } from '@xenova/transformers';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ODataService, EntityType, Property } from '../types/sap-types.js';
import { Logger } from '../utils/logger.js';

// Configure transformers.js to use local cache and suppress console output
env.cacheDir = join(dirname(fileURLToPath(import.meta.url)), '../../.cache/transformers');
env.allowRemoteModels = true;
// CRITICAL: Suppress all console output from transformers.js for MCP stdio compatibility
// The transformers library logs download progress to stdout which breaks MCP JSON-RPC protocol
(env as Record<string, unknown>).logLevel = 'error'; // Suppress info/warn logs

/**
 * Metadata stored for each embedded entity
 */
export interface EntityMetadata {
    serviceId: string;
    serviceName: string;
    serviceDescription: string;
    entityName: string;
    entitySet: string | null | undefined;
    keyProperties: string[];
    sampleProperties: string[];
    domain: string;
    embeddingDocument: string;
}

/**
 * Search result with similarity score
 */
export interface SearchResult {
    metadata: EntityMetadata;
    score: number;
}

/**
 * Cache file structure
 */
interface EmbeddingCache {
    version: string;
    model: string;
    timestamp: number;
    entityCount: number;
    embeddings: Record<string, {
        vector: number[];
        metadata: EntityMetadata;
    }>;
}

const CACHE_VERSION = '1.0';
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const VECTOR_DIMENSIONS = 384;

/**
 * Patterns to skip when embedding entities (non-business entities)
 */
const SKIP_PATTERNS = [
    /^VL_/,           // Value help entities
    /^I_/,            // Interface entities
    /^SAP__/,         // System entities
    /^P_/,            // Parameter entities
    /Parameters$/,    // Parameter type entities
    /^_/,             // Internal entities
    /DraftAdministrativeData/, // Draft admin
];

/**
 * Properties to skip when building embedding document
 */
const SKIP_PROPERTY_PATTERNS = [
    /^SAP__/,         // SAP system fields
    /^_/,             // Internal fields
    /LastChanged/i,   // Audit fields
    /CreatedBy/i,
    /ModifiedBy/i,
    /^UUID$/i,
    /^GUID$/i,
    /^ETag$/i,
    /DraftUUID/i,
];

export class EmbeddingService {
    private embedder: Pipeline | null = null;
    private embeddings: Map<string, { vector: number[]; metadata: EntityMetadata }> = new Map();
    private isInitialized = false;
    private cachePath: string;
    private logger: Logger;

    constructor(logger: Logger, cachePath?: string) {
        this.logger = logger;
        this.cachePath = cachePath || join(
            dirname(fileURLToPath(import.meta.url)),
            '../../.cache/embeddings-cache.json'
        );
    }

    /**
     * Initialize the embedding model
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        this.logger.info('🧠 Initializing embedding model...');
        const startTime = Date.now();

        try {
            // Ensure cache directory exists
            const cacheDir = dirname(this.cachePath);
            if (!existsSync(cacheDir)) {
                await mkdir(cacheDir, { recursive: true });
            }

            // CRITICAL: Suppress console.log during model loading
            // The transformers library outputs progress to stdout which breaks MCP stdio protocol
            const originalConsoleLog = console.log;
            const originalConsoleInfo = console.info;
            console.log = () => {}; // Suppress during model loading
            console.info = () => {}; // Suppress during model loading

            try {
                // Load the embedding pipeline
                this.embedder = await pipeline('feature-extraction', MODEL_NAME, {
                    quantized: true, // Use quantized model for faster inference
                });
            } finally {
                // Restore console functions
                console.log = originalConsoleLog;
                console.info = originalConsoleInfo;
            }

            this.isInitialized = true;
            const elapsed = Date.now() - startTime;
            this.logger.info(`✅ Embedding model loaded in ${elapsed}ms`);
        } catch (error) {
            this.logger.error('❌ Failed to initialize embedding model:', error);
            throw error;
        }
    }

    /**
     * Generate embedding for a text
     */
    async embed(text: string): Promise<number[]> {
        if (!this.embedder) {
            throw new Error('Embedding model not initialized. Call initialize() first.');
        }

        const output = await this.embedder(text, {
            pooling: 'mean',
            normalize: true,
        });

        // Convert Float32Array to regular array
        return Array.from(output.data as Float32Array);
    }

    /**
     * Check if an entity should be skipped
     */
    private shouldSkipEntity(entityName: string): boolean {
        return SKIP_PATTERNS.some(pattern => pattern.test(entityName));
    }

    /**
     * Check if a property is business-relevant
     */
    private isBusinessRelevantProperty(propName: string): boolean {
        return !SKIP_PROPERTY_PATTERNS.some(pattern => pattern.test(propName));
    }

    /**
     * Build a rich embedding document for an entity
     */
    private buildEmbeddingDocument(service: ODataService, entity: EntityType): string {
        // Get business-relevant properties (max 15)
        const relevantProps = entity.properties
            ?.filter(p => this.isBusinessRelevantProperty(p.name))
            .slice(0, 15)
            .map(p => p.name)
            .join(', ') || '';

        // Get key properties
        const keyProps = entity.keys?.join(', ') || '';

        // Build a rich document for embedding
        const doc = `
SAP OData Service: ${service.title}
Service Description: ${service.description}
Entity: ${entity.name}
Entity Set: ${entity.entitySet || entity.name}
Key Fields: ${keyProps}
Business Fields: ${relevantProps}
Domain: AR Accounts Receivable
Capabilities: ${entity.creatable ? 'Create' : ''} ${entity.updatable ? 'Update' : ''} ${entity.deletable ? 'Delete' : ''} Read
        `.trim();

        return doc;
    }

    /**
     * Index all entities from discovered services
     */
    async indexEntities(services: ODataService[], forceReindex = false): Promise<void> {
        if (!this.isInitialized) {
            await this.initialize();
        }

        // Try to load from cache first
        if (!forceReindex && await this.loadCache(services)) {
            this.logger.info(`📦 Loaded ${this.embeddings.size} embeddings from cache`);
            return;
        }

        this.logger.info(`🔄 Indexing entities from ${services.length} services...`);
        const startTime = Date.now();
        let entityCount = 0;
        let skippedCount = 0;

        for (const service of services) {
            const entityTypes = service.metadata?.entityTypes || [];
            
            for (const entity of entityTypes) {
                // Skip non-business entities
                if (this.shouldSkipEntity(entity.name)) {
                    skippedCount++;
                    continue;
                }

                const embeddingId = `${service.id}::${entity.name}`;
                const doc = this.buildEmbeddingDocument(service, entity);
                
                try {
                    const vector = await this.embed(doc);
                    
                    const metadata: EntityMetadata = {
                        serviceId: service.id,
                        serviceName: service.title,
                        serviceDescription: service.description,
                        entityName: entity.name,
                        entitySet: entity.entitySet,
                        keyProperties: entity.keys || [],
                        sampleProperties: entity.properties
                            ?.filter(p => this.isBusinessRelevantProperty(p.name))
                            .slice(0, 10)
                            .map(p => p.name) || [],
                        domain: 'AR',
                        embeddingDocument: doc,
                    };

                    this.embeddings.set(embeddingId, { vector, metadata });
                    entityCount++;

                    // Log progress every 50 entities
                    if (entityCount % 50 === 0) {
                        this.logger.info(`  ⏳ Indexed ${entityCount} entities...`);
                    }
                } catch (error) {
                    this.logger.warn(`Failed to embed entity ${embeddingId}:`, error);
                }
            }
        }

        const elapsed = Date.now() - startTime;
        this.logger.info(`✅ Indexed ${entityCount} entities in ${elapsed}ms (skipped ${skippedCount} non-business entities)`);

        // Save to cache
        await this.saveCache();
    }

    /**
     * Index services (not entities) using hints for V2 lightweight discovery
     * This works WITHOUT metadata - uses service catalog + hints only
     */
    async indexServicesWithHints(
        services: ODataService[], 
        getHint: (serviceId: string) => { label?: string; useFor?: string; entities?: string[]; tcode?: string } | null
    ): Promise<void> {
        if (!this.isInitialized) {
            await this.initialize();
        }

        this.logger.info(`🔄 Indexing ${services.length} services with hints...`);
        const startTime = Date.now();
        let indexedCount = 0;

        for (const service of services) {
            const hint = getHint(service.id);
            
            // Build embedding document from service info + hints
            const doc = `
SAP OData Service: ${hint?.label || service.title}
Service ID: ${service.id}
Description: ${hint?.useFor || service.description}
Domain: ${service.domain || 'General'} ${service.domain === 'AR' ? 'Accounts Receivable Customer Invoices Payments' : ''}
Tier: ${service.tier === 1 ? 'Transactional CRUD operations' : service.tier === 2 ? 'Display read-only' : service.tier === 3 ? 'Analytics dashboard KPIs' : 'General'}
${hint?.tcode ? `SAP Transaction: ${hint.tcode}` : ''}
${hint?.entities ? `Key Entities: ${hint.entities.join(', ')}` : ''}
            `.trim();

            try {
                const vector = await this.embed(doc);
                
                const metadata: EntityMetadata = {
                    serviceId: service.id,
                    serviceName: hint?.label || service.title,
                    serviceDescription: hint?.useFor || service.description,
                    entityName: '', // Not indexing entities
                    entitySet: null,
                    keyProperties: [],
                    sampleProperties: hint?.entities || [],
                    domain: service.domain || 'General',
                    embeddingDocument: doc,
                };

                // Use service ID as embedding key (no entity)
                this.embeddings.set(service.id, { vector, metadata });
                indexedCount++;

                // Log progress every 100 services
                if (indexedCount % 100 === 0) {
                    this.logger.info(`  ⏳ Indexed ${indexedCount} services...`);
                }
            } catch (error) {
                this.logger.warn(`Failed to embed service ${service.id}:`, error);
            }
        }

        const elapsed = Date.now() - startTime;
        this.logger.info(`✅ Indexed ${indexedCount} services in ${elapsed}ms`);

        // Save to cache
        await this.saveCache();
    }

    /**
     * Semantic search for services (V2 - returns service-level results)
     */
    async searchServices(query: string, topK: number = 20, minScore: number = 0.25): Promise<SearchResult[]> {
        if (!this.isInitialized) {
            throw new Error('Embedding service not initialized');
        }

        if (this.embeddings.size === 0) {
            this.logger.warn('No embeddings indexed. Search returning empty results.');
            return [];
        }

        const startTime = Date.now();
        
        // Embed the query
        const queryVector = await this.embed(query);

        // Compute similarity scores
        const scored: SearchResult[] = [];
        
        for (const [id, item] of this.embeddings.entries()) {
            const score = this.cosineSimilarity(queryVector, item.vector);
            if (score >= minScore) {
                scored.push({
                    metadata: item.metadata,
                    score,
                });
            }
        }

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);

        // Take top K
        const results = scored.slice(0, topK);

        const elapsed = Date.now() - startTime;
        this.logger.debug(`Semantic search for "${query}" found ${results.length} services in ${elapsed}ms`);

        return results;
    }

    /**
     * Compute cosine similarity between two vectors
     */
    private cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) {
            throw new Error('Vectors must have same dimensions');
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
        if (magnitude === 0) return 0;

        return dotProduct / magnitude;
    }

    /**
     * Semantic search for entities
     */
    async search(query: string, topK: number = 10, minScore: number = 0.3): Promise<SearchResult[]> {
        if (!this.isInitialized) {
            throw new Error('Embedding service not initialized');
        }

        if (this.embeddings.size === 0) {
            this.logger.warn('No embeddings indexed. Search returning empty results.');
            return [];
        }

        const startTime = Date.now();
        
        // Embed the query
        const queryVector = await this.embed(query);

        // Compute similarity scores
        const scored: SearchResult[] = [];
        
        for (const [id, item] of this.embeddings.entries()) {
            const score = this.cosineSimilarity(queryVector, item.vector);
            if (score >= minScore) {
                scored.push({
                    metadata: item.metadata,
                    score,
                });
            }
        }

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);

        // Take top K
        const results = scored.slice(0, topK);

        const elapsed = Date.now() - startTime;
        this.logger.debug(`Semantic search for "${query}" found ${results.length} results in ${elapsed}ms`);

        return results;
    }

    /**
     * Get all indexed entities (for fallback)
     */
    getAllEntities(): EntityMetadata[] {
        return Array.from(this.embeddings.values()).map(item => item.metadata);
    }

    /**
     * Get embedding count
     */
    getEmbeddingCount(): number {
        return this.embeddings.size;
    }

    /**
     * Check if service has been updated (for cache invalidation)
     */
    private computeServicesHash(services: ODataService[]): string {
        const serviceIds = services.map(s => s.id).sort().join(',');
        const entityCounts = services.map(s => s.metadata?.entityTypes?.length || 0).join(',');
        return `${serviceIds}|${entityCounts}`;
    }

    /**
     * Save embeddings to cache file
     */
    async saveCache(): Promise<void> {
        try {
            const cacheDir = dirname(this.cachePath);
            if (!existsSync(cacheDir)) {
                await mkdir(cacheDir, { recursive: true });
            }

            const cache: EmbeddingCache = {
                version: CACHE_VERSION,
                model: MODEL_NAME,
                timestamp: Date.now(),
                entityCount: this.embeddings.size,
                embeddings: Object.fromEntries(this.embeddings),
            };

            await writeFile(this.cachePath, JSON.stringify(cache), 'utf-8');
            this.logger.info(`💾 Saved ${this.embeddings.size} embeddings to cache`);
        } catch (error) {
            this.logger.warn('Failed to save embedding cache:', error);
        }
    }

    /**
     * Load embeddings from cache file
     * Returns true if cache was loaded successfully
     */
    async loadCache(currentServices?: ODataService[]): Promise<boolean> {
        try {
            if (!existsSync(this.cachePath)) {
                this.logger.debug('No embedding cache file found');
                return false;
            }

            const cacheContent = await readFile(this.cachePath, 'utf-8');
            const cache: EmbeddingCache = JSON.parse(cacheContent);

            // Validate cache version
            if (cache.version !== CACHE_VERSION) {
                this.logger.info(`Cache version mismatch (${cache.version} vs ${CACHE_VERSION}), reindexing...`);
                return false;
            }

            // Validate model
            if (cache.model !== MODEL_NAME) {
                this.logger.info(`Cache model mismatch (${cache.model} vs ${MODEL_NAME}), reindexing...`);
                return false;
            }

            // Optionally validate against current services
            if (currentServices) {
                const expectedCount = currentServices.reduce((sum, s) => {
                    const entities = s.metadata?.entityTypes || [];
                    const businessEntities = entities.filter(e => !this.shouldSkipEntity(e.name));
                    return sum + businessEntities.length;
                }, 0);

                // Allow some tolerance (5% difference)
                const tolerance = Math.max(10, Math.floor(expectedCount * 0.05));
                if (Math.abs(cache.entityCount - expectedCount) > tolerance) {
                    this.logger.info(`Cache entity count mismatch (${cache.entityCount} vs ~${expectedCount}), reindexing...`);
                    return false;
                }
            }

            // Load embeddings
            this.embeddings = new Map(Object.entries(cache.embeddings));

            // Log cache age
            const cacheAge = Date.now() - cache.timestamp;
            const cacheAgeHours = Math.floor(cacheAge / (1000 * 60 * 60));
            this.logger.debug(`Loading cache from ${cacheAgeHours} hours ago`);

            return true;
        } catch (error) {
            this.logger.warn('Failed to load embedding cache:', error);
            return false;
        }
    }

    /**
     * Clear the embedding cache
     */
    async clearCache(): Promise<void> {
        this.embeddings.clear();
        try {
            if (existsSync(this.cachePath)) {
                const { unlink } = await import('fs/promises');
                await unlink(this.cachePath);
                this.logger.info('Cleared embedding cache');
            }
        } catch (error) {
            this.logger.warn('Failed to delete cache file:', error);
        }
    }

    /**
     * Check if service is ready for search
     */
    isReady(): boolean {
        return this.isInitialized && this.embeddings.size > 0;
    }
}
