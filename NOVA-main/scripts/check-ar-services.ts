/**
 * Diagnostic script to check how many AR/Accounts Receivable services exist in SAP
 * Run with: npx tsx scripts/check-ar-services.ts
 */

import fs from 'fs';
import path from 'path';

interface V2Service {
    ID: string;
    TechnicalServiceVersion?: string;
    Title?: string;
    Description?: string;
    ServiceUrl: string;
    TechnicalServiceName: string;
}

// AR-related patterns to search for
const AR_PATTERNS = [
    /receivable/i,
    /\bar[\s_-]/i,      // "AR " or "AR_" or "AR-" 
    /ar_/i,             // ar_ prefix
    /_ar_/i,            // _ar_ in middle
    /^ar[_\s]/i,        // starts with ar_ or ar 
    /customer.*invoice/i,
    /billing/i,
    /collection/i,
    /dunning/i,
    /credit.*memo/i,
    /debit.*memo/i,
    /payment.*receive/i,
    /customer.*payment/i,
    /fiar/i,            // FI-AR module
    /bsid/i,            // AR line items
    /bsad/i,            // Cleared AR
    /financial.*document/i,
];

async function main() {
    console.log('🔍 Checking SAP Catalog for AR/Accounts Receivable services...\n');

    try {
        // Load destination from default-env.json
        const defaultEnvPath = path.join(process.cwd(), 'default-env.json');
        if (!fs.existsSync(defaultEnvPath)) {
            console.error('❌ default-env.json not found');
            return;
        }

        const envConfig = JSON.parse(fs.readFileSync(defaultEnvPath, 'utf-8'));
        const destinations = JSON.parse(envConfig.destinations || '[]');
        const sapDest = Array.isArray(destinations) 
            ? destinations.find((d: any) => d.name === 'SAP_SYSTEM') 
            : destinations;

        if (!sapDest) {
            console.error('❌ SAP_SYSTEM destination not found in default-env.json');
            return;
        }

        console.log(`✅ Using destination: ${sapDest.url}\n`);

        // Build basic auth header
        const auth = Buffer.from(`${sapDest.username}:${sapDest.password}`).toString('base64');
        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'Authorization': `Basic ${auth}`,
        };
        if (sapDest['sap-client']) {
            headers['sap-client'] = sapDest['sap-client'];
        }

        // Fetch V2 catalog
        const url = `${sapDest.url}/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection`;
        console.log(`📡 Fetching catalog from: ${url}\n`);

        const response = await fetch(url, { headers });
        
        if (!response.ok) {
            console.error(`❌ HTTP ${response.status}: ${response.statusText}`);
            return;
        }

        const data = await response.json() as { d?: { results?: V2Service[] } };
        const results: V2Service[] = data.d?.results || [];

        console.log(`📊 Total services in SAP catalog: ${results.length}\n`);

        // Filter AR-related services
        const arServices = results.filter(service => {
            const searchText = `${service.ID} ${service.Title || ''} ${service.Description || ''} ${service.TechnicalServiceName}`;
            return AR_PATTERNS.some(pattern => pattern.test(searchText));
        });

        console.log(`🎯 AR-related services found: ${arServices.length}\n`);
        console.log('─'.repeat(80));

        // List all AR services
        console.log('\n📋 AR-Related Services:\n');
        for (const service of arServices) {
            console.log(`  • ${service.ID}`);
            console.log(`    Title: ${service.Title || 'N/A'}`);
            if (service.Description) console.log(`    Desc: ${service.Description}`);
            console.log('');
        }

        // Summary
        console.log('─'.repeat(80));
        console.log('\n📈 SUMMARY:');
        console.log(`   Total SAP services: ${results.length}`);
        console.log(`   AR-related services: ${arServices.length}`);
        console.log(`   Current MAX_SERVICES cap: ${process.env.ODATA_MAX_SERVICES || '10 (default)'}`);
        console.log(`\n   ⚠️  With current cap, only ${process.env.ODATA_MAX_SERVICES || '10'} services are loaded at startup.`);
        console.log(`   💡 To include all AR services, either:`);
        console.log(`      - Set ODATA_MAX_SERVICES=${Math.max(arServices.length + 20, 100)} (or higher)`);
        console.log(`      - Use ODATA_SERVICE_PATTERNS to filter for AR/Finance specifically\n`);

        // Additional analysis: show all services for context
        console.log('\n📋 First 50 services (alphabetical) for reference:\n');
        const sorted = [...results].sort((a, b) => a.ID.localeCompare(b.ID));
        for (const service of sorted.slice(0, 50)) {
            console.log(`  ${service.ID}`);
        }
        if (results.length > 50) {
            console.log(`  ... and ${results.length - 50} more`);
        }

    } catch (error) {
        console.error('❌ Error:', error);
    }
}

main();
