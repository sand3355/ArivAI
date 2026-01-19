# SAP OData to MCP Server for BTP 🚀

## 🎯 **Project Goal**

Transform your SAP S/4HANA or ECC system into a **conversational AI interface** by exposing OData services as dynamic MCP tools. This enables natural language interactions with your ERP data:

- **"Show me customer line items for company AA01"** → Discovers AR service, fetches schema, queries Items entity
- **"What is the balance for customer ZA01?"** → Finds balance service, falls back to line items if no data
- **"Set payment block on document 1400003681"** → Executes PATCH on UpdatableItem entity

---

## 🏗️ **Architecture Overview**

### **V2: Tiering + Hints + Vector Search + 3-Layer MCP Tools**

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           SAP OData MCP Server (V2)                            │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────────┐   │
│  │  SAP Catalog    │───►│  Domain + Tier   │───►│   Vector Index          │   │
│  │  697 Services   │    │  Classification  │    │   (all-MiniLM-L6-v2)    │   │
│  └─────────────────┘    └──────────────────┘    └─────────────────────────┘   │
│         │                       │                         │                    │
│         ▼                       ▼                         ▼                    │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                     Service Hints (domain-tier-config.ts)               │  │
│  │  • label: "Customer Line Items (FBL5N)"                                 │  │
│  │  • useFor: "View customer invoices, open items, set payment blocks"     │  │
│  │  • tcode: "FBL5N"                                                       │  │
│  │  • entities: ["Item", "UpdatableItem", "Customer"]                      │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         3-Layer MCP Tool Flow                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│   User Query: "Show line items for customer ZA01"                              │
│                           │                                                     │
│                           ▼                                                     │
│   ┌─────────────────────────────────────────────────────────────────────────┐  │
│   │ LAYER 1: discover-sap-data                                              │  │
│   │ • Vector search finds semantically similar services                     │  │
│   │ • Results reranked by tier (Tier 1 > Tier 2 > Tier 3)                  │  │
│   │ • Returns: top 10 service IDs + names (no metadata, no data)           │  │
│   └─────────────────────────────────────────────────────────────────────────┘  │
│                           │                                                     │
│                           ▼                                                     │
│   ┌─────────────────────────────────────────────────────────────────────────┐  │
│   │ LAYER 2: get-entity-metadata                                            │  │
│   │ • Lazy-loads full schema for selected service/entity                   │  │
│   │ • Returns: properties, types, keys, CRUD capabilities                  │  │
│   │ • Cached in memory after first fetch                                   │  │
│   └─────────────────────────────────────────────────────────────────────────┘  │
│                           │                                                     │
│                           ▼                                                     │
│   ┌─────────────────────────────────────────────────────────────────────────┐  │
│   │ LAYER 3: execute-sap-operation                                          │  │
│   │ • Executes OData query with user-provided filters                      │  │
│   │ • Operations: read, read-single, create, update, delete                │  │
│   │ • Returns: actual SAP data                                             │  │
│   └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### **Progressive Service Narrowing**

```
697 total SAP services (catalog)
    │
    ▼ Domain filter (e.g., "AR")
53 AR-related services
    │
    ▼ Vector search + tier rerank
10 most relevant services shown to LLM
    │
    ▼ LLM picks 1 service
1 service → metadata fetched
    │
    ▼ LLM builds query
Filtered data returned
```

---

## 🧠 **Core Technical Components**

### **1. Domain Classification & Tiering**

Services are classified by domain and tiered by importance:

| Tier | Description | Example Services |
|------|-------------|------------------|
| **Tier 1** | Transactional (CRUD) | `ZFAR_CUSTOMER_LINE_ITEMS`, `ZFAR_PAYMENT_POST` |
| **Tier 2** | Display/Reference | `ZFAR_BALANCES_V2`, `ZFAR_CUSTOMER_LIST` |
| **Tier 3** | Analytics/Dashboard | `ZC_TOTALACCOUNTSRECEIVABLES_CDS`, `ZFAR_AR_OVP` |

**Domain patterns (AR example):**
```typescript
prefixes: [/^Z?FAR_/i, /RECEIVABLE/i, /^Z?UI_COLL/i]
excludePatterns: [/^RAR_/i]  // Revenue Accounting ≠ AR!
```

### **2. Service Hints**

Rich metadata added to services for better LLM understanding:

```typescript
'ZFAR_CUSTOMER_LINE_ITEMS_0001': {
    label: 'Customer Line Items (FBL5N)',
    useFor: 'View INDIVIDUAL customer invoices, line items, open items, 
             set payment blocks. NOT for aggregate balances.',
    entities: ['Item', 'UpdatableItem', 'Customer'],
    tcode: 'FBL5N'
}
```

### **3. Vector Search (Semantic)**

Each service is converted into a rich **embedding document** that captures both SAP catalog data and our custom hints:

```
SAP OData Service: Customer Line Items (FBL5N)
Service ID: ZFAR_CUSTOMER_LINE_ITEMS_0001
Description: View INDIVIDUAL customer invoices, line items, open items...
Domain: AR Accounts Receivable Customer Invoices Payments
Tier: Transactional CRUD operations
SAP Transaction: FBL5N
Key Entities: Item, UpdatableItem, Customer
```

**Embedding Document Composition:**

| Field | Source | Purpose |
|-------|--------|---------|
| `SAP OData Service` | `hint.label` or SAP catalog `title` | Human-readable name with T-code |
| `Service ID` | SAP catalog `id` | Exact service identifier |
| `Description` | `hint.useFor` or SAP catalog `description` | Rich description of when to use |
| `Domain` | Classified domain + expansion keywords | e.g., "AR Accounts Receivable Customer Invoices" |
| `Tier` | Tier number → semantic meaning | "Transactional CRUD" vs "Analytics dashboard" |
| `SAP Transaction` | `hint.tcode` | Links to SAP GUI transaction (FBL5N, F-28, etc.) |
| `Key Entities` | `hint.entities` | Main entity sets in this service |

**Why this matters**: The embedding model converts this text into a 384-dimensional vector. When a user asks "what do customers owe", the query vector is compared against all service vectors. Services with "customer", "invoices", "open items", "receivables" in their document will score higher.

**Technology stack:**
- **Model**: `all-MiniLM-L6-v2` (384 dimensions, ~80MB)
- **Library**: `@xenova/transformers` (runs locally, no API calls)
- **Storage**: In-memory with disk cache (`.cache/embeddings-cache.json`)
- **Similarity**: Cosine similarity with configurable threshold (default: 0.25)
- **Process**: Text → Tokenize → Embed → 384-dim vector → Cosine similarity search

### **4. Hybrid Search Strategy**

```
Query → Semantic Search (primary)
              │
              ├─ Results found? → Tier rerank → Return
              │
              └─ No results? → Pattern matching fallback
                                    │
                                    └─ Searches: ID, title, hints (label, useFor, tcode)
```

### **5. Local-First Architecture**

Everything runs on your machine:
- **Embedding model**: Loads locally via `@xenova/transformers`
- **Vector index**: In-memory with JSON disk cache
- **MCP Server**: Node.js process connects directly to SAP
- **No external AI services**: No OpenAI, no vector databases, no cloud dependencies

---

## ✨ **Key Features**

### **🔍 Intelligent Service Discovery**
- Vector-based semantic search understands query meaning
- Tier-based ranking prioritizes transactional services
- Domain filtering focuses on relevant business areas
- Priority services (like `ZFAR_CUSTOMER_LINE_ITEMS`) always surface first

### **📋 Lazy Metadata Loading**
- Catalog discovery fetches only ID, title, description
- Full metadata fetched on-demand when LLM requests it
- Metadata cached in memory after first fetch
- Reduces startup time and token usage

### **⚡ 3-Layer Progressive Disclosure**
- **Layer 1**: Lightweight discovery (minimal tokens)
- **Layer 2**: Full schema on-demand (only when needed)
- **Layer 3**: Execute with proper context (LLM has schema)

### **🎯 MCP-Native with Soft Guidance**
- LLM dynamically discovers and chooses services (true MCP behavior)
- Hints and tiering act as "soft guidance"—influences what it sees first
- LLM makes contextual decisions, we ensure critical services surface

---

## 📋 **Available MCP Tools**

### **Tool 1: `discover-sap-data`**

**Purpose**: Find relevant SAP OData services using semantic search

**Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Natural language search query |
| `domain` | string | Optional domain filter (AR, AP, GL, SD, etc.) |
| `limit` | number | Max results (default: 10) |

**Returns**: Service IDs, names, tiers, match scores (no metadata, no data)

**Example**:
```javascript
discover-sap-data({ 
  query: "customer line items open invoices", 
  domain: "AR" 
})
// → Returns top 10 AR services ranked by relevance + tier
```

---

### **Tool 2: `get-entity-metadata`**

**Purpose**: Get full schema for a specific entity

**Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `serviceId` | string | Service ID from discovery |
| `entityName` | string | Entity name to get schema for |

**Returns**: Properties, types, keys, nullable flags, CRUD capabilities

**Example**:
```javascript
get-entity-metadata({
  serviceId: "ZFAR_CUSTOMER_LINE_ITEMS_0001",
  entityName: "Item"
})
// → Returns 226 properties, keys, read/update capabilities
```

---

### **Tool 3: `execute-sap-operation`**

**Purpose**: Execute CRUD operations on SAP OData entities

**Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `serviceId` | string | Service ID |
| `entityName` | string | Entity name |
| `operation` | string | read, read-single, create, update, delete |
| `filterString` | string | OData $filter expression |
| `selectString` | string | OData $select fields |
| `topNumber` | number | OData $top limit |
| `parameters` | object | Key-value pairs for create/update |

**Example**:
```javascript
execute-sap-operation({
  serviceId: "ZFAR_CUSTOMER_LINE_ITEMS_0001",
  entityName: "Item",
  operation: "read",
  filterString: "CompanyCode eq 'AA01' and Customer eq 'ZA01'",
  selectString: "Customer,CustomerName,AmountInCompanyCodeCurrency",
  topNumber: 100
})
```

---

## 🎯 **Example Workflow**

```
User: "Show line items for customer ZA01 in company AA01"

┌─────────────────────────────────────────────────────────────────┐
│ Step 1: discover-sap-data                                       │
│ Query: "line items customer"                                    │
│ Domain: "AR"                                                    │
│                                                                 │
│ Results (ranked by tier + relevance):                          │
│   1. Customer Line Items (FBL5N) [Tier 1] 45%                  │
│   2. Customer Balances (FD10N) [Tier 2] 36%                    │
│   3. AR Overview Page [Tier 3] 28%                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: get-entity-metadata                                     │
│ Service: ZFAR_CUSTOMER_LINE_ITEMS_0001                         │
│ Entity: Item                                                    │
│                                                                 │
│ Returns: 226 properties, read=✓, update=✗, delete=✗            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: execute-sap-operation                                   │
│ Operation: read                                                 │
│ Filter: CompanyCode eq 'AA01' and Customer eq 'ZA01'           │
│                                                                 │
│ Returns: 3 line items with amounts, dates, document numbers    │
└─────────────────────────────────────────────────────────────────┘
```

---

## ⚙️ **Configuration**

### **Environment Variables**

```env
# SAP Connection
SAP_DESTINATION=my-sap-destination

# Semantic Search
ENABLE_SEMANTIC_SEARCH=true        # Enable vector search (default: true)
EMBEDDING_CACHE_PATH=.cache/embeddings-cache.json

# Service Discovery
ODATA_MAX_SERVICES=100             # Max services to discover (for testing)
ODATA_INCLUDE_PATTERNS=*FAR*,*AR*  # Include patterns (comma-separated)
ODATA_EXCLUDE_PATTERNS=*TEST*      # Exclude patterns (comma-separated)

# Server
PORT=3000
LOG_LEVEL=info
```

### **Domain Configuration**

Edit `src/config/domain-tier-config.ts` to:
- Add new domains (AP, GL, MM, etc.)
- Customize tier keywords
- Add service hints for your specific services
- Define priority services

---

## 🛠️ **Installation & Setup**

### **Prerequisites**
- Node.js 18.x or higher
- SAP S/4HANA or ECC with OData services enabled  
- SAP BTP account with Destination service (or direct connection)

### **Quick Start**

```bash
# Clone repository
git clone https://github.com/asyncawaiter/sap_mcp.git
cd sap_mcp

# Install dependencies
npm install

# Configure SAP connection
cp .env.example .env
# Edit .env with your SAP destination

# Build
npm run build

# Run (stdio for Claude Desktop)
npm run start:stdio
```

### **Claude Desktop Configuration**

Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "sap-mcp": {
      "command": "node",
      "args": ["/path/to/sap_mcp/dist/stdio-entry.js"],
      "env": {
        "SAP_DESTINATION": "my-sap-destination"
      }
    }
  }
}
```

---

## 📊 **Performance**

| Metric | Value |
|--------|-------|
| First startup (model download + indexing 697 services) | ~20-30 seconds |
| Cached startup | ~3-5 seconds |
| Vector search latency | ~50ms embedding + ~5ms search |
| Metadata cache hit | <1ms |
| SAP query execution | Depends on SAP system |

---

## 🔒 **Security**

### **SAP BTP Integration**
- Uses BTP Destination service for authentication
- Supports Principal Propagation and OAuth2
- Secure credential storage in BTP

### **Local Security**
- All AI processing happens locally (no data sent to external AI services)
- Embedding model runs in-process
- Vector index stored locally

### **HTTP Transport Security** (when using HTTP mode)
- Helmet.js security headers
- CORS protection
- DNS rebinding attack prevention
- Session management with automatic cleanup

---

## 📚 **Additional Documentation**

- [Local Development Guide](./docs/LOCAL_RUN.md)
- [BTP Deployment Guide](./docs/DEPLOYMENT.md)

---

## 🤝 **Contributing**

1. Fork the repository
2. Create a feature branch
3. Add hints for new domains in `src/config/domain-tier-config.ts`
4. Submit a pull request

