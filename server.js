require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
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
async function getValidAccessToken(portalId) {
    const { data: installation, error } = await supabase.from('hubspot_tokens').select('refresh_token, access_token, expires_at').eq('id', 1).single();
    if (error || !installation) throw new Error(`Could not find installation. Please reinstall the app by visiting the install URL.`);
    
    let { refresh_token, access_token, expires_at } = installation;
    
    if (new Date() > new Date(expires_at)) {
        console.log('Refreshing expired access token...');
        const response = await fetch('https://api.hubapi.com/oauth/v1/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token }), });
        if (!response.ok) throw new Error('Failed to refresh access token');
        const newTokens = await response.json();
        access_token = newTokens.access_token;
        const newExpiresAt = new Date(Date.now() + newTokens.expires_in * 1000).toISOString();
        await supabase.from('hubspot_tokens').update({ access_token, expires_at: newExpiresAt }).eq('id', 1);
    }
    return access_token;
}

// --- API Routes ---
app.get('/api/install', (req, res) => {
    const SCOPES = 'oauth crm.objects.companies.read crm.objects.contacts.read crm.objects.deals.read crm.schemas.companies.read crm.schemas.contacts.read forms marketing-email automation.workflows.read';
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
        
        const tokenInfoResponse = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${access_token}`);
        if (!tokenInfoResponse.ok) throw new Error('Failed to fetch HubSpot token info');
        const tokenInfo = await tokenInfoResponse.json();
        const portalId = tokenInfo.hub_id;

        await supabase.from('hubspot_tokens').upsert({ id: 1, refresh_token, access_token, expires_at: expiresAt }, { onConflict: 'id' });
        
        res.redirect(`${APP_BASE_URL}/?portalId=${portalId}`);
    } catch (error) {
        console.error(error);
        res.status(500).send(`<h1>Server Error</h1><p>${error.message}</p>`);
    }
});

// --- NEW AI READINESS AUDIT ENDPOINT ---
app.get('/api/ai-readiness-audit', async (req, res) => {
    const portalId = req.header('X-HubSpot-Portal-Id');
    if (!portalId) {
        return res.status(400).json({ message: 'HubSpot Portal ID is missing.' });
    }

    try {
        const accessToken = await getValidAccessToken(portalId);
        const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

        // --- Define Individual Audit Checks ---

        // Check 1: Contact to Company Association Rate
        const getAssociationRate = async () => {
            const totalContactsSearch = { limit: 1, properties: ['hs_object_id'] };
            const associatedContactsSearch = {
                filterGroups: [{ filters: [{ propertyName: 'associations.company', operator: 'HAS_PROPERTY' }] }],
                limit: 1
            };

            const totalRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', { method: 'POST', headers, body: JSON.stringify(totalContactsSearch) });
            const associatedRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', { method: 'POST', headers, body: JSON.stringify(associatedContactsSearch) });

            if (!totalRes.ok || !associatedRes.ok) throw new Error('Failed to fetch contact association data.');
            
            const totalData = await totalRes.json();
            const associatedData = await associatedRes.json();
            
            const totalContacts = totalData.total;
            const associatedContacts = associatedData.total;

            const rate = (totalContacts > 0) ? Math.round((associatedContacts / totalContacts) * 100) : 0;
            return {
                metric: 'Contact to Company Association Rate',
                value: `${rate}%`,
                description: `Of ${totalContacts.toLocaleString()} total contacts, ${associatedContacts.toLocaleString()} are associated with a company.`
            };
        };

        // Check 2: Lifecycle Stage Distribution
        const getLifecycleDistribution = async () => {
            const aggregationBody = {
                "aggregations": [{
                    "propertyName": "lifecyclestage",
                    "aggregationType": "COUNT"
                }]
            };

            const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/aggregation', { method: 'POST', headers, body: JSON.stringify(aggregationBody) });
            if (!response.ok) return { metric: 'Lifecycle Stage Distribution', value: 'API Error', description: 'Could not fetch lifecycle stage data. This API may require a Marketing Hub Professional subscription or higher.'};
            
            const data = await response.json();
            const distribution = data.results.map(item => ({ stage: item.label, count: item.count }));

            return {
                metric: 'Lifecycle Stage Distribution',
                value: `${distribution.length} stages in use`,
                details: distribution,
                description: 'The breakdown of contacts by their current lifecycle stage.'
            };
        };

        // Check 3: Active Workflow Count
        const getWorkflowCount = async () => {
            const response = await fetch('https://api.hubapi.com/automation/v3/workflows', { headers });
            if (!response.ok) return { metric: 'Workflow Count', value: 'API Error', description: 'Could not fetch workflow data. Your granted scopes may not include "automation.workflows.read" or the portal may not have access to this API.'};

            const data = await response.json();
            const activeWorkflows = data.results.filter(wf => wf.enabled).length;
            
            return {
                metric: 'Active Workflow Count',
                value: activeWorkflows.toLocaleString(),
                description: `There are ${activeWorkflows} active workflows in this portal.`
            };
        };

        // --- Run all checks in parallel for speed ---
        const results = await Promise.all([
            getAssociationRate(),
            getLifecycleDistribution(),
            getWorkflowCount()
        ]);
        
        res.json({ auditResults: results, timestamp: new Date().toISOString() });

    } catch (error) {
        console.error("AI Readiness Audit Error:", error);
        res.status(500).json({ message:
