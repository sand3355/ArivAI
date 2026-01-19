/**
 * Stdio Entry Point V2 - Lightweight Catalog Discovery with Semantic Search
 * 
 * This entry point initializes the SAP MCP server with the V2 architecture:
 * - Fast startup: Only fetches catalog (no metadata)
 * - All services discoverable: No MAX_SERVICES cap
 * - Lazy loading: Metadata fetched on demand
 * - Semantic search: Vector embeddings for natural language queries
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { Logger } from './utils/logger.js';
import { Config } from './utils/config.js';
import { DestinationService } from './services/destination-service.js';
import { SAPClient } from './services/sap-client.js';
import { SAPDiscoveryService } from './services/sap-discovery.js';
import { EmbeddingService } from './services/embedding-service.js';
import { getServiceHint } from './config/domain-tier-config.js';
import { runStdioServer } from './mcp-server.js';

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Load .env file manually (to avoid dotenv stdout pollution)
try {
    const envPath = join(projectRoot, '.env');
    if (existsSync(envPath)) {
        const envContent = readFileSync(envPath, 'utf-8');
        for (const line of envContent.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const eqIndex = trimmed.indexOf('=');
                if (eqIndex > 0) {
                    const key = trimmed.slice(0, eqIndex).trim();
                    const value = trimmed.slice(eqIndex + 1).trim();
                    if (!process.env[key]) {
                        process.env[key] = value;
                    }
                }
            }
        }
    }
} catch {
    // Will be logged later
}

// Load default-env.json
try {
    const defaultEnvPath = join(projectRoot, 'default-env.json');
    const defaultEnv = JSON.parse(readFileSync(defaultEnvPath, 'utf-8'));
    
    for (const [key, value] of Object.entries(defaultEnv)) {
        if (!process.env[key]) {
            process.env[key] = typeof value === 'string' ? value : JSON.stringify(value);
        }
    }
} catch {
    // Will be logged later
}

async function main() {
    const logger = new Logger('stdio-entry');
    
    try {
        logger.info('Starting SAP MCP Server V2 in stdio mode...');
        const startTime = Date.now();
        
        // Initialize services
        const config = new Config();
        const destinationService = new DestinationService(logger, config);
        await destinationService.initialize();
        
        const sapClient = new SAPClient(destinationService, logger);
        const discoveryService = new SAPDiscoveryService(sapClient, logger);
        
        // V2: Lightweight catalog discovery (no metadata fetching)
        logger.info('Discovering SAP OData service catalog...');
        const catalogServices = await discoveryService.discoverCatalog();
        
        const catalogElapsed = Date.now() - startTime;
        logger.info(`✅ Discovered ${catalogServices.length} services in ${catalogElapsed}ms`);
        
        // Count by domain/tier
        const stats: Record<string, number> = {};
        for (const s of catalogServices) {
            const key = `${s.domain || 'other'}-T${s.tier || 0}`;
            stats[key] = (stats[key] || 0) + 1;
        }
        logger.info(`   Stats: ${JSON.stringify(stats)}`);
        
        // Initialize embedding service for semantic search
        let embeddingService: EmbeddingService | undefined;
        const enableSemanticSearch = process.env.ENABLE_SEMANTIC_SEARCH !== 'false';
        
        if (enableSemanticSearch) {
            try {
                logger.info('🧠 Initializing semantic search...');
                embeddingService = new EmbeddingService(logger);
                await embeddingService.initialize();
                
                // Index services with hints (not entities - we don't have metadata yet)
                await embeddingService.indexServicesWithHints(catalogServices, getServiceHint);
                
                logger.info(`✅ Semantic search ready with ${embeddingService.getEmbeddingCount()} indexed services`);
            } catch (embeddingError) {
                logger.warn('⚠️ Semantic search initialization failed, falling back to pattern matching:', embeddingError);
                embeddingService = undefined;
            }
        } else {
            logger.info('ℹ️ Semantic search disabled (ENABLE_SEMANTIC_SEARCH=false)');
        }
        
        const totalElapsed = Date.now() - startTime;
        logger.info(`🚀 Total startup time: ${totalElapsed}ms`);
        
        // Start MCP server
        logger.info('📡 Starting MCP server...');
        await runStdioServer(catalogServices, discoveryService, embeddingService);
        
    } catch (error) {
        logger.error('Failed to start stdio server:', error);
        process.exit(1);
    }
}

main();
