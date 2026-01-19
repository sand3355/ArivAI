/**
 * Domain and Tier Configuration for SAP OData Service Classification
 * 
 * This module provides modular, extensible configuration for classifying
 * SAP OData services by business domain (AR, AP, GL, etc.) and tier
 * (transactional, display, analytics).
 * 
 * TIERS:
 *   Tier 1 - Transactional: Services that support CRUD operations (MANAGE, CREATE, POST)
 *   Tier 2 - Display/Reference: Read-only services for viewing data (DISPLAY, HISTORY, LIST)
 *   Tier 3 - Analytics: Dashboard/KPI services, Smart Business tiles (_CDS, _OVP_)
 * 
 * To add a new domain (e.g., Accounts Payable):
 *   1. Add a new DomainConfig object to DOMAIN_CONFIGS array
 *   2. Define prefixes, tier keywords, exclusions, and priority services
 *   3. No code changes needed elsewhere - classification is automatic
 */

export interface DomainConfig {
    /** Short domain identifier (e.g., 'AR', 'AP', 'GL') */
    name: string;
    
    /** Human-readable name (e.g., 'Accounts Receivable') */
    displayName: string;
    
    /** Regex patterns that identify services belonging to this domain */
    prefixes: RegExp[];
    
    /** Keywords that indicate Tier 1 (transactional) services */
    tier1Keywords: RegExp[];
    
    /** Keywords that indicate Tier 2 (display/reference) services */
    tier2Keywords: RegExp[];
    
    /** Keywords that indicate Tier 3 (analytics) services */
    tier3Keywords: RegExp[];
    
    /** Patterns to exclude (false positives) */
    excludePatterns: RegExp[];
    
    /** Service IDs that should always be Tier 1 with highest priority */
    priorityServices: string[];
}

export interface ServiceClassification {
    domain: string | null;
    tier: number;
    priority: number;
    isPriorityService: boolean;
}

/**
 * Service hints for LLM decision making
 * These act as "prompt engineering" at the discovery layer
 */
export interface ServiceHint {
    /** Short label for the service (overrides SAP catalog name) */
    label: string;
    /** When to use this service - helps LLM pick the right one */
    useFor: string;
    /** Key entities in this service */
    entities?: string[];
    /** SAP transaction code equivalent (if any) */
    tcode?: string;
}

/**
 * Service hints map - Add hints for services that need better LLM guidance
 * Key: Service ID (case-insensitive matching)
 */
export const SERVICE_HINTS: Record<string, ServiceHint> = {
    // ==================== AR TIER 1 (Transactional) ====================
    
    'ZFAR_CUSTOMER_LINE_ITEMS_0001': {
        label: 'Customer Line Items (FBL5N)',
        useFor: 'View INDIVIDUAL customer invoices, line items, open items list, cleared items, document details, specific invoice lookup, set payment blocks. Use this for item-level details NOT for aggregate balances/totals.',
        entities: ['Item', 'UpdatableItem', 'Customer'],
        tcode: 'FBL5N'
    },
    
    'ZFAR_PAYMENT_POST_SRV_0001': {
        label: 'Post Incoming Payments (F-28)',
        useFor: 'Post customer payments, cash receipts, payment on account, clear open items',
        entities: ['Payment', 'PaymentItem'],
        tcode: 'F-28'
    },
    
    'ZFAR_DOWN_PAYMENT_REQUEST_MANAGE_SR_0001': {
        label: 'Manage Down Payment Requests',
        useFor: 'Create, display, modify customer down payment requests and advances',
        entities: ['DownPaymentRequest'],
        tcode: 'F-37'
    },
    
    'ZFAR_MANAGE_PR_SRV_0001': {
        label: 'Manage Posting Rules',
        useFor: 'Create and maintain automatic posting rules for incoming payments',
        entities: ['PostingRule']
    },
    
    'ZFAR_MANAGE_INCOMING_PAYT_FILES_SRV_0001': {
        label: 'Manage Incoming Payment Files',
        useFor: 'Upload, process, and manage bank payment files (lockbox, BAI, MT940)',
        entities: ['PaymentFile', 'PaymentFileItem']
    },
    
    'ZFAR_MY_DUNNING_PROPOSAL_SRV_0001': {
        label: 'Dunning Proposal Management',
        useFor: 'Create dunning proposals, review dunning letters, execute dunning runs',
        entities: ['DunningProposal', 'DunningItem'],
        tcode: 'F150'
    },
    
    'ZFAR_DISP_PROCESS_FLOW_SRV_0001': {
        label: 'AR Document Process Flow',
        useFor: 'View document flow from sales order to invoice to payment',
        entities: ['ProcessFlow', 'DocumentFlow']
    },
    
    'ZFAR_DISP_PAYMENT_CARD_DATA_SRV_0001': {
        label: 'Payment Card Data',
        useFor: 'View and manage credit card payment information for customers',
        entities: ['PaymentCard']
    },
    
    'ZUI_PROCESSRECEIVABLES_MAN_0001': {
        label: 'Manage Customer Receivables',
        useFor: 'Process receivables, apply payments, handle disputes, manage collections',
        entities: ['Receivable', 'Payment', 'Dispute']
    },
    
    'ZUI_COLL_CONTACT_MANAGE_0001': {
        label: 'Collections Contact Management',
        useFor: 'Log collection calls, schedule follow-ups, record customer promises to pay',
        entities: ['CollectionContact', 'PromiseToPay']
    },
    
    'ZUI_COLLECTIONS_EMAIL_0001': {
        label: 'Collections Email',
        useFor: 'Send collection emails to customers, track email history',
        entities: ['CollectionEmail']
    },
    
    'ZUDMO_COLLECTION_WORKLIST_0001': {
        label: 'Collections Worklist',
        useFor: 'View and work collection worklist items, prioritize collection activities',
        entities: ['WorklistItem', 'CollectionCase']
    },
    
    // ==================== AR TIER 2 (Display/Reference) ====================
    
    'ZFAR_BALANCES_V2_SRV_0001': {
        label: 'Customer Balances (FD10N)',
        useFor: 'Show customer BALANCE, total balance, account balance summary, aggregate amounts owed by customer per fiscal year. Use this for "show balance" or "what is the balance" queries, NOT for individual line items.',
        entities: ['CustomerBalanceSet', 'BalanceComparisonSet', 'SpecialGLBalanceSet'],
        tcode: 'FD10N'
    },
    
    'ZFAR_CUSTOMER_LIST_V2_0001': {
        label: 'Customer Master List',
        useFor: 'Search and browse customer master data',
        entities: ['Customer']
    },
    
    'ZFAR_DUNNING_HISTORY_SRV_0001': {
        label: 'Dunning History',
        useFor: 'View dunning history, past dunning letters sent to customers',
        entities: ['DunningHistory']
    },
    
    'ZFAR_CORRESPONDENCE_HISTORY_SRV_0001': {
        label: 'AR Correspondence History',
        useFor: 'View account statements, balance confirmations sent to customers',
        entities: ['Correspondence']
    },
    
    'ZFAR_INSPECT_ITEMS_CHNGLOG_SRV_0001': {
        label: 'Line Item Change Log',
        useFor: 'View audit trail of changes to AR line items (who changed what, when)',
        entities: ['ChangeLog']
    },
    
    'ZFAR_DOUBTFUL_ACCTS_VALUATION_SRV_0001': {
        label: 'Doubtful Accounts Valuation',
        useFor: 'View bad debt provisions, doubtful receivables valuation',
        entities: ['ValuationResult']
    },
    
    'ZFAR_BAD_DEBT_RESERVE_SRV_0001': {
        label: 'Bad Debt Reserve',
        useFor: 'View bad debt reserve calculations and allowances',
        entities: ['BadDebtReserve']
    },
    
    'ZUI_HOBRECEIVABLES_DISPLAY_0001': {
        label: 'Receivables Overview Display',
        useFor: 'Display receivables overview, high-level AR summaries',
        entities: ['ReceivablesOverview']
    },
    
    // ==================== AR TIER 3 (Analytics/Dashboard) ====================
    
    'ZC_TOTALACCOUNTSRECEIVABLES_CDS_0001': {
        label: 'Total Accounts Receivable Analytics',
        useFor: 'View AR KPIs, aging analysis, total receivables by company code, aging buckets report, overdue amounts dashboard, AR analytics',
        entities: ['TotalReceivables', 'AgingBucket']
    },
    
    'ZFAR_AR_OVP_SRV_0001': {
        label: 'AR Overview Page',
        useFor: 'Accounts receivable dashboard, AR manager overview, key metrics and charts',
        entities: ['AROverview', 'ARMetrics']
    },
};

/**
 * Domain configurations - Add new domains here
 */
export const DOMAIN_CONFIGS: DomainConfig[] = [
    {
        name: 'AR',
        displayName: 'Accounts Receivable',
        prefixes: [
            /^Z?FAR_/i,           // FI-AR module services
            /^Z?FIAR_/i,          // Alternative FI-AR prefix
            /RECEIVABLE/i,        // Contains "receivable"
            /^Z?UI_.*RECEIVABLE/i, // UI services for receivables
            /^Z?UI_COLL/i,        // Collections UI services
            /^Z?UDMO_COLLECTION/i, // Collections worklist
        ],
        tier1Keywords: [
            /CUSTOMER_LINE_ITEMS/i,    // FBL5N equivalent - THE most important
            /PAYMENT_POST/i,           // Post incoming payments (F-28)
            /MANAGE/i,                 // Manage operations
            /CREATE/i,                 // Create operations
            /WORKLIST/i,               // Worklists are actionable
            /DOWN_PAYMENT/i,           // Down payment processing
            /POSTING_RULES?/i,         // Posting rules management
            /INCOMING_PAYT/i,          // Incoming payment files
        ],
        tier2Keywords: [
            /DISPLAY/i,                // Display-only
            /HISTORY/i,                // History views
            /LIST_V?\d?/i,             // List views (LIST, LIST_V2)
            /BALANCES/i,               // Balance displays
            /CORRESPONDENCE/i,         // Correspondence history
            /INSPECT/i,                // Inspection views
            /VALUATION/i,              // Valuation reports
            /RESERVE/i,                // Reserve displays
        ],
        tier3Keywords: [
            /_CDS$/i,                  // CDS consumption views (analytics)
            /_OVP_/i,                  // Overview Page services
            /PROCFLOW/i,               // Process flow visualization
            /_FS_SRV/i,                // Fact Sheet services
            /OVERVIEW/i,               // Overview services
            /TRACKER/i,                // Tracker cards
            /BREAKDOWN/i,              // Breakdown analytics
            /AGING/i,                  // Aging analysis
            /PROGRESS/i,               // Progress tracking
        ],
        excludePatterns: [
            /^RAR_/i,                  // Revenue Accounting & Reporting (NOT AR!)
        ],
        priorityServices: [
            'ZFAR_CUSTOMER_LINE_ITEMS_0001',  // #1 most important AR service
        ]
    },
    
    // SD (Sales & Distribution) - Billing/Invoicing related to AR
    {
        name: 'SD',
        displayName: 'Sales & Distribution',
        prefixes: [
            /^Z?SD_/i,                 // SD module services
            /BILLING/i,                // Billing services
            /INVOICE/i,                // Invoice services
            /CREDIT.*MEMO/i,           // Credit memos
            /DEBIT.*MEMO/i,            // Debit memos
        ],
        tier1Keywords: [
            /MANAGE/i,
            /CREATE/i,
            /_WL_SRV/i,                // Worklist services
        ],
        tier2Keywords: [
            /DISPLAY/i,
            /LIST/i,
            /_OP_SRV/i,                // Object Page services
        ],
        tier3Keywords: [
            /_CDS$/i,
            /PROCFLOW/i,
            /_FS_SRV/i,                // Fact Sheet
        ],
        excludePatterns: [],
        priorityServices: [
            'ZSD_CUSTOMER_INVOICES_MANAGE_0001',
            'ZSD_CUSTOMER_INVOICES_CREATE_0001',
        ]
    },
    
    // Finance General - Covers financial documents, dunning, collections
    {
        name: 'FI',
        displayName: 'Finance',
        prefixes: [
            /^Z?FAC_/i,                // Financial Accounting
            /^Z?FI_/i,                 // FI module
            /DUNNING/i,                // Dunning services
            /COLLECTION/i,             // Collection services
            /FINANCIAL.*DOC/i,         // Financial documents
        ],
        tier1Keywords: [
            /MANAGE/i,
            /POST/i,
            /PROPOSAL/i,               // Dunning proposals are actionable
            /EXCEPTION/i,              // Exception handling
        ],
        tier2Keywords: [
            /DISPLAY/i,
            /HISTORY/i,
            /REVERSAL/i,
        ],
        tier3Keywords: [
            /_CDS$/i,
            /_OVP_/i,
            /DISTRIBUTION/i,
        ],
        excludePatterns: [],
        priorityServices: []
    },
];

/**
 * Priority score calculation:
 * - Lower score = higher priority
 * - Priority services: 1
 * - Tier 1: 10-19
 * - Tier 2: 20-29
 * - Tier 3: 30-39
 * - Unclassified: 100
 */
const PRIORITY_SCORES = {
    PRIORITY_SERVICE: 1,
    TIER_1: 10,
    TIER_2: 20,
    TIER_3: 30,
    UNCLASSIFIED: 100,
};

/**
 * Check if a service ID matches any pattern in an array
 */
function matchesAny(value: string, patterns: RegExp[]): boolean {
    return patterns.some(pattern => pattern.test(value));
}

/**
 * Determine the tier of a service based on its ID and title
 */
function determineTier(serviceId: string, title: string, config: DomainConfig): number {
    const searchText = `${serviceId} ${title}`;
    
    // Check tier keywords in order (Tier 1 takes precedence)
    if (matchesAny(searchText, config.tier1Keywords)) {
        return 1;
    }
    if (matchesAny(searchText, config.tier2Keywords)) {
        return 2;
    }
    if (matchesAny(searchText, config.tier3Keywords)) {
        return 3;
    }
    
    // Default to Tier 1 if service matches domain prefix but no tier keywords
    // (Assume it's transactional if we can't tell)
    return 1;
}

/**
 * Classify a service by domain and tier
 * 
 * @param serviceId - The service ID (e.g., 'ZFAR_CUSTOMER_LINE_ITEMS_0001')
 * @param title - The service title (e.g., 'customer line items (aka fbl5n)')
 * @returns Classification with domain, tier, priority, and priority service flag
 */
export function classifyService(serviceId: string, title: string): ServiceClassification {
    const upperServiceId = serviceId.toUpperCase();
    
    // Check each domain configuration
    for (const config of DOMAIN_CONFIGS) {
        // Check if explicitly excluded
        if (matchesAny(upperServiceId, config.excludePatterns)) {
            continue;
        }
        
        // Check if service matches this domain's prefixes
        if (matchesAny(upperServiceId, config.prefixes) || matchesAny(title, config.prefixes)) {
            // Check if it's a priority service
            const isPriorityService = config.priorityServices.some(
                ps => ps.toUpperCase() === upperServiceId
            );
            
            if (isPriorityService) {
                return {
                    domain: config.name,
                    tier: 1,
                    priority: PRIORITY_SCORES.PRIORITY_SERVICE,
                    isPriorityService: true,
                };
            }
            
            // Determine tier
            const tier = determineTier(serviceId, title, config);
            const basePriority = tier === 1 ? PRIORITY_SCORES.TIER_1 
                               : tier === 2 ? PRIORITY_SCORES.TIER_2 
                               : PRIORITY_SCORES.TIER_3;
            
            return {
                domain: config.name,
                tier,
                priority: basePriority,
                isPriorityService: false,
            };
        }
    }
    
    // No domain matched - unclassified
    return {
        domain: null,
        tier: 0,
        priority: PRIORITY_SCORES.UNCLASSIFIED,
        isPriorityService: false,
    };
}

/**
 * Check if a service should be excluded (false positive)
 */
export function isExcludedService(serviceId: string): boolean {
    const upperServiceId = serviceId.toUpperCase();
    return DOMAIN_CONFIGS.some(config => 
        matchesAny(upperServiceId, config.excludePatterns)
    );
}

/**
 * Get the display name for a domain
 */
export function getDomainDisplayName(domain: string | null): string {
    if (!domain) return 'Unclassified';
    const config = DOMAIN_CONFIGS.find(c => c.name === domain);
    return config?.displayName || domain;
}

/**
 * Get all configured domain names
 */
export function getConfiguredDomains(): string[] {
    return DOMAIN_CONFIGS.map(c => c.name);
}

/**
 * Get priority services for a domain
 */
export function getPriorityServicesForDomain(domain: string): string[] {
    const config = DOMAIN_CONFIGS.find(c => c.name === domain);
    return config?.priorityServices || [];
}

/**
 * Get hints for a service (for LLM guidance)
 * Returns null if no hints defined
 */
export function getServiceHint(serviceId: string): ServiceHint | null {
    const upperServiceId = serviceId.toUpperCase();
    
    // Find matching hint (case-insensitive)
    for (const [id, hint] of Object.entries(SERVICE_HINTS)) {
        if (id.toUpperCase() === upperServiceId) {
            return hint;
        }
    }
    
    return null;
}

