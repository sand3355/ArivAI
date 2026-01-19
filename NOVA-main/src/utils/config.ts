/**
 * Configuration Manager V2
 * 
 * Simplified configuration for the V2 tiered discovery architecture.
 * Service filtering is now handled by domain-tier-config.ts.
 */

import xsenv from '@sap/xsenv';

export class Config {
    private config: Map<string, unknown> = new Map();

    constructor() {
        this.loadConfiguration();
    }

    private loadConfiguration(): void {
        // Core settings
        this.config.set('sap.destinationName', process.env.SAP_DESTINATION_NAME || 'SAP_SYSTEM');
        this.config.set('sap.discoveryDestinationName', process.env.SAP_DISCOVERY_DESTINATION_NAME);
        this.config.set('sap.executionDestinationName', process.env.SAP_EXECUTION_DESTINATION_NAME);
        
        // Request settings
        this.config.set('request.timeout', parseInt(process.env.REQUEST_TIMEOUT || '30000'));
        this.config.set('request.retries', parseInt(process.env.REQUEST_RETRIES || '3'));
        
        // Logging
        this.config.set('log.level', process.env.LOG_LEVEL || 'info');
        this.config.set('node.env', process.env.NODE_ENV || 'development');

        // Load VCAP services if available
        try {
            xsenv.loadEnv();
            const vcapServices = process.env.VCAP_SERVICES ? JSON.parse(process.env.VCAP_SERVICES) : {};
            this.config.set('vcap.services', vcapServices);
        } catch {
            // Silently ignore - VCAP not available in local mode
        }
    }

    /**
     * Get a configuration value
     */
    get<T = string>(key: string, defaultValue?: T): T {
        const value = this.config.get(key);
        if (value === undefined) {
            return defaultValue as T;
        }
        return value as T;
    }

    /**
     * Set a configuration value
     */
    set(key: string, value: unknown): void {
        this.config.set(key, value);
    }

    /**
     * Check if a configuration key exists
     */
    has(key: string): boolean {
        return this.config.has(key);
    }

    /**
     * Get all configuration values
     */
    getAll(): Record<string, unknown> {
        return Object.fromEntries(this.config);
    }
}
