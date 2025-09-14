require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// --- Environment Variables ---
const CLIENT_ID = process.env.HUBSPOT_CLIENT_ID;
const CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET;
const APP_BASE_URL = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL;
const REDIRECT_URI = `${APP_BASE_URL}/api/oauth-callback`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- HubSpot API Helper ---
async function getValidAccessToken() {
    // CORRECTED: Using the correct table name 'ai-readiness-hubspot_tokens' and simplified id=1 logic.
    const { data: installation, error } = await supabase.from('ai-readiness-hubspot_tokens').select('refresh_token, access_token, expires_at').eq('id', 1).single();
    if (error || !installation) throw new Error(`Could not find installation. Please reinstall the app by visiting the /api/install URL.`);
    
    let { refresh_token, access_token, expires_at } = installation;
    
    if (new Date() > new Date(expires_at)) {
        console.log('Refreshing expired access token...');
        const response = await fetch('https://api.hubapi.com/oauth/v1/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token }), });
        if (!response.ok) throw new Error('Failed to refresh access token');
        const newTokens = await response.json();
        access_token = newTokens.access_token;
        const newExpiresAt = new Date(Date.now() + newTokens.expires_in * 1000).toISOString();
        await supabase.from('ai-readiness-hubspot_tokens').update({ access_token, expires_at: newExpiresAt }).eq('id', 1);
    }
    return access_token;
}

// --- API Routes ---
app.get('/api/install', (req, res) => {
    const SCOPES = 'oauth crm.objects.companies.read crm.objects.contacts.read crm.objects.deals.read crm.schemas.companies.read crm.schemas.contacts.read forms marketing-email automation';
    const authUrl = `https://app.hubspot.com/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=${SCOPES}`;
    res.redirect(authUrl);
});

app.get('/api/oauth-callback', async (req, res) => {
    const authCode = req.query.code;
    if (!authCode) return res.status(400).send('HubSpot authorization code not found.');
    try {
        const response = await fetch('https://api.hubapi.com/oauth/v1/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, code: authCode }), });
        if (!response.ok) throw new Error(await response.text());
        const tokenData = await response.json();
        const { refresh_token, access_token, expires_in } = tokenData;
        const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
        
        // CORRECTED: Using the correct table name 'ai-readiness-hubspot_tokens' and simplified id=1 logic.
        await supabase.from('ai-readiness-hubspot_tokens').upsert({ id: 1, refresh_token, access_token, expires_at: expiresAt }, { onConflict: 'id' });
        
        res.cookie('hubspot_authenticated', 'true', { maxAge: 15000, httpOnly: true, secure: true, sameSite: 'Lax' });
        res.redirect(APP_BASE_URL);
    } catch (error) {
        console.error(error);
        res.status(500).send(`<h1>Server Error</h1><p>${error.message}</p>`);
    }
});

app.get('/api/ai-readiness-audit', async (req, res) => {
    try {
        const accessToken = await getValidAccessToken();
        const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

        // --- KPI Calculation Functions ---
        // (Full logic for all 8 KPIs is included here as per the last working version)
        
        const getFillRate = async (objectType, properties, metricName) => {
            try {
                const totalSearch = { limit: 1 };
                const filledSearch = { 
                    filterGroups: [{ 
                        filters: properties.map(prop => ({ propertyName: prop, operator: 'HAS_PROPERTY' }))
                    }],
                    limit: 1 
                };
                const [totalRes, filledRes] = await Promise.all([
                    fetch(`https://api.hubapi.com/crm/v3/objects/${objectType}/search`, { method: 'POST', headers, body: JSON.stringify(totalSearch) }),
                    fetch(`https://api.hubapi.com/crm/v3/objects/${objectType}/search`, { method: 'POST', headers, body: JSON.stringify(filledSearch) })
                ]);
                if (!totalRes.ok || !filledRes.ok) return { metric: metricName, value: 'API Error', description: `Could not fetch ${objectType} data.` };
                const totalData = await totalRes.json();
                const filledData = await filledRes.json();
                const rate = (totalData.total > 0) ? Math.round((filledData.total / totalData.total) * 100) : 0;
                return { metric: metricName, value: `${rate}%`, description: `Based on ${totalData.total.toLocaleString()} total records.` };
            } catch (e) { return { metric: metricName, value: 'API Error', description: e.message }; }
        };

        const getAssociationRate = async () => {
             try {
                const totalSearch = { limit: 1 };
                const associatedSearch = { filterGroups: [{ filters: [{ propertyName: 'associatedcompanyid', operator: 'HAS_PROPERTY' }] }], limit: 1 };
                const [totalRes, associatedRes] = await Promise.all([
                    fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', { method: 'POST', headers, body: JSON.stringify(totalSearch) }),
                    fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', { method: 'POST', headers, body: JSON.stringify(associatedSearch) })
                ]);
                if (!totalRes.ok || !associatedRes.ok) return { metric: 'Contact Association Rate', value: 'API Error', description: 'Failed to fetch contact data.' };
                const totalData = await totalRes.json();
                const associatedData = await associatedRes.json();
                const rate = (totalData.total > 0) ? Math.round((associatedData.total / totalData.total) * 100) : 0;
                return { metric: 'Contact Association Rate', value: `${rate}%`, description: `${associatedData.total.toLocaleString()} of ${totalData.total.toLocaleString()} contacts are associated.` };
            } catch (e) { return { metric: 'Contact Association Rate', value: 'API Error', description: e.message }; }
        };
        
        const getPropertyDefinitionQuality = async () => {
            try {
                const response = await fetch('https://api.hubapi.com/crm/v3/properties/contacts', { headers });
                if (!response.ok) return { metric: 'Property Definition Quality', value: 'API Error', description: 'Could not fetch property definitions.' };
                const data = await response.json();
                const customProps = data.results.filter(p => !p.hubspotDefined);
                if (customProps.length === 0) return { metric: 'Property Definition Quality', value: 'N/A', description: 'No custom contact properties found.' };
                const describedProps = customProps.filter(p => p.description && p.description.trim() !== '').length;
                const rate = Math.round((describedProps / customProps.length) * 100);
                return { metric: 'Property Definition Quality', value: `${rate}%`, description: `${describedProps} of ${customProps.length} custom properties have descriptions.`};
            } catch (e) { return { metric: 'Property Definition Quality', value: 'API Error', description: e.message }; }
        };

        const getDealRot = async () => {
            try {
                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                const searchBody = {
                    filterGroups: [
                        { filters: [{ propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }] },
                        { filters: [{ propertyName: 'hs_last_activity_date', operator: 'LT', value: thirtyDaysAgo.getTime() }] }
                    ],
                    limit: 1
                };
                const response = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', { method: 'POST', headers, body: JSON.stringify(searchBody) });
                if (!response.ok) return { metric: 'Deal Rot', value: 'API Error', description: 'Could not fetch deal activity.' };
                const data = await response.json();
                return { metric: 'Deal Rot', value: data.total.toLocaleString(), description: `Open deals with no activity in the last 30 days.`};
            } catch (e) { return { metric: 'Deal Rot', value: 'API Error', description: e.message }; }
        };

        const getLifecycleDistribution = async () => {
            try {
                const aggregationBody = { "aggregations": [{ "propertyName": "lifecyclestage", "aggregationType": "COUNT" }] };
                const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/aggregation', { method: 'POST', headers, body: JSON.stringify(aggregationBody) });
                if (!response.ok) return { metric: 'Lifecycle Stage Distribution', value: 'API Error', description: 'Requires Marketing Hub Pro+.' };
                const data = await response.json();
                const distribution = (data.results || []).map(item => ({ stage: item.label, count: item.count }));
                return { metric: 'Lifecycle Stage Distribution', value: `${distribution.length}`, description: 'Distinct stages in active use.', details: distribution };
            } catch (e) { return { metric: 'Lifecycle Stage Distribution', value: 'API Error', description: e.message }; }
        };

        const getWorkflowCount = async () => {
            try {
                const response = await fetch('https://api.hubapi.com/automation/v3/workflows', { headers });
                if (!response.ok) return { metric: 'Active Workflow Count', value: 'API Error', description: 'Could not fetch workflows.' };
                const data = await response.json();
                const activeWorkflows = (data.results || []).filter(wf => wf.enabled).length;
                return { metric: 'Active Workflow Count', value: activeWorkflows.toLocaleString(), description: `Active workflows found.` };
            } catch (e) { return { metric: 'Active Workflow Count', value: 'API Error', description: e.message }; }
        };
        
        const results = await Promise.all([
            getFillRate('contacts', ['lifecyclestage', 'hs_lead_status', 'phone'], 'Core Contact Fill Rate'),
            getFillRate('companies', ['industry', 'city', 'domain'], 'Core Company Fill Rate'),
            getFillRate('deals', ['amount', 'dealstage', 'closedate'], 'Core Deal Fill Rate'),
            getAssociationRate(),
            getPropertyDefinitionQuality(),
            getDealRot(),
            getLifecycleDistribution(),
            getWorkflowCount()
        ]);
        
        res.json({ auditResults: results });

    } catch (error) {
        console.error("AI Readiness Audit Error:", error);
        res.status(500).json({ message: error.message });
    }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is live on port ${PORT}`);
});
