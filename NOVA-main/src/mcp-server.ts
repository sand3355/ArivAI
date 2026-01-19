/**
 * MCP Server V2 - Tiered Discovery with Lazy Metadata Loading
 * 
 * This server provides the MCP interface for SAP OData services.
 * V2 uses lightweight catalog discovery with lazy metadata loading.
 */

import { HierarchicalSAPToolRegistry } from './tools/hierarchical-tool-registry.js';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { DestinationService } from './services/destination-service.js';
import { SAPClient } from './services/sap-client.js';
import { SAPDiscoveryService } from './services/sap-discovery.js';
import { EmbeddingService } from './services/embedding-service.js';
import { Logger } from './utils/logger.js';
import { Config } from './utils/config.js';
import { ErrorHandler } from './utils/error-handler.js';
import { ODataService } from './types/sap-types.js';

export class MCPServer {
    private logger: Logger;
    private sapClient: SAPClient;
    private mcpServer: McpServer;
    private toolRegistry: HierarchicalSAPToolRegistry;
    private userToken?: string;

    constructor(
        catalogServices: ODataService[],
        discoveryService: SAPDiscoveryService,
        embeddingService?: EmbeddingService
    ) {
        this.logger = new Logger('mcp-server');
        const config = new Config();
        const destinationService = new DestinationService(this.logger, config);
        this.sapClient = new SAPClient(destinationService, this.logger);
        
        this.mcpServer = new McpServer({
            name: "btp-sap-odata-to-mcp-server",
            version: "2.0.0"
        });
        
        this.mcpServer.server.onerror = (error) => {
            this.logger.error('MCP Server Error:', error);
            ErrorHandler.handle(error);
        };

        // V2: Use hierarchical registry with discovery service for lazy loading
        this.toolRegistry = new HierarchicalSAPToolRegistry(
            this.mcpServer,
            this.sapClient,
            this.logger,
            catalogServices,
            discoveryService,
            embeddingService
        );
        
        this.logger.info('Using HierarchicalSAPToolRegistry V2 (tiered discovery + lazy loading)');
    }

    /**
     * Set the user's JWT token for authenticated operations
     */
    setUserToken(token?: string): void {
        this.userToken = token;
        this.toolRegistry.setUserToken(token);
        this.logger.debug(`User token ${token ? 'set' : 'cleared'}`);
    }

    /**
     * Initialize the MCP server
     */
    async initialize(): Promise<void> {
        try {
            this.toolRegistry.registerServiceMetadataResources();
            await this.toolRegistry.registerDiscoveryTools();
            this.logger.info('🔧 Registered MCP tools for SAP operations');
        } catch (error) {
            this.logger.error('❌ Failed to initialize server:', error);
            throw error;
        }
    }

    /**
     * Connect to stdio transport
     */
    async connectStdio(): Promise<void> {
        const transport = new StdioServerTransport();
        await this.mcpServer.connect(transport);
        this.logger.info('📡 Connected to stdio transport');
    }

    /**
     * Create HTTP transport
     */
    createHTTPTransport(options?: {
        enableDnsRebindingProtection?: boolean;
        allowedHosts?: string[];
    }): StreamableHTTPServerTransport {
        return new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: options?.enableDnsRebindingProtection ?? true,
            allowedHosts: options?.allowedHosts || ['127.0.0.1', 'localhost']
        });
    }

    /**
     * Get the underlying MCP server
     */
    getServer(): McpServer {
        return this.mcpServer;
    }
}

/**
 * Create and initialize an MCP server
 */
export async function createMCPServer(
    catalogServices: ODataService[],
    discoveryService: SAPDiscoveryService,
    options?: {
        userToken?: string;
        embeddingService?: EmbeddingService;
    }
): Promise<MCPServer> {
    const server = new MCPServer(catalogServices, discoveryService, options?.embeddingService);
    if (options?.userToken) {
        server.setUserToken(options.userToken);
    }
    await server.initialize();
    return server;
}

/**
 * Run MCP server in stdio mode
 */
export async function runStdioServer(
    catalogServices: ODataService[],
    discoveryService: SAPDiscoveryService,
    embeddingService?: EmbeddingService
): Promise<void> {
    const logger = new Logger('sap-mcp-server');
    try {
        const server = await createMCPServer(catalogServices, discoveryService, { embeddingService });
        await server.connectStdio();
        logger.info('SAP MCP Server V2 running on stdio...');
    } catch (error) {
        logger.error('Failed to start SAP MCP Server:', error);
        process.exit(1);
    }
}
