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

// --- CORRECTED ENVIRONMENT VARIABLES ---
const CLIENT_ID = process.env.HUBSPOT_CLIENT_ID;
const CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET;
// CORRECTED: REDIRECT_URI now uses the APP_BASE_URL environment variable from Railway.
const REDIRECT_URI = `${process.env.APP_BASE_URL}/api/oauth-callback`; 
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- HubSpot API Helper ---
// CORRECTED: This function is updated to work with our new 'hubspot_tokens' table schema.
async function getValidAccessToken(portalId) {
    // We are now using a single row with id=1 to store the token for this single-portal app.
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
    // CORRECTED: The SCOPES constant now contains the full, correct list for the AI Auditor.
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

        // This is a temporary way to get the portal ID for the single-portal app.
        const tokenInfoResponse = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${access_token}`);
        if (!tokenInfoResponse.ok) throw new Error('Failed to fetch HubSpot token info');
        const tokenInfo = await tokenInfoResponse.json();
        const portalId = tokenInfo.hub_id;

        // CORRECTED: This logic now uses our new 'hubspot_tokens' table.
        await supabase.from('hubspot_tokens').upsert({ id: 1, refresh_token, access_token, expires_at: expiresAt }, { onConflict: 'id' });
        
        // Redirecting back to the base URL to show the main app page with the portal ID.
        res.redirect(`${process.env.APP_BASE_URL}/?portalId=${portalId}`);
    } catch (error) {
        console.error(error);
        res.status(500).send(`<h1>Server Error</h1><p>${error.message}</p>`);
    }
});

// NOTE: This is the logic from your previous project.
// We will replace the contents of this endpoint with our new "AI Readiness" checks in the next phase.
app.get('/api/audit', async (req, res) => {
    // For this app, the portalId will come from the frontend after install.
    const portalId = req.header('X-HubSpot-Portal-Id');
    const objectType = req.query.objectType || 'contacts';
    if (!portalId) return res.status(400).json({ message: 'HubSpot Portal ID is missing.' });
    try {
        const accessToken = await getValidAccessToken(portalId);
        const propertiesUrl = `https://api.hubapi.com/crm/v3/properties/${objectType}?archived=false`;
        const propertiesResponse = await fetch(propertiesUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (!propertiesResponse.ok) throw new Error(`Failed to fetch properties for ${objectType}`);
        const propertiesData = await propertiesResponse.json();
        const allProperties = propertiesData.results;
        const propertyNames = allProperties.map(p => p.name);
        const totalCountResponse = await fetch(`https://api.hubapi.com/crm/v3/objects/${objectType}/search`, { method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 1, properties: ["hs_object_id"] }), });
        if (!totalCountResponse.ok) throw new Error('Failed to fetch total record count');
        const totalCountData = await totalCountResponse.json();
        const totalRecords = totalCountData.total;
        let recordsSample = [];
        if (totalRecords > 0) {
            let after = undefined;
            for (let i = 0; i < 10; i++) { // Fetch up to 1000 records
                const sampleUrl = `https://api.hubapi.com/crm/v3/objects/${objectType}?limit=100&properties=${propertyNames.join(',')}` + (after ? `&after=${after}` : '');
                const sampleResponse = await fetch(sampleUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
                if (!sampleResponse.ok) break;
                const sampleData = await sampleResponse.json();
                recordsSample.push(...sampleData.results);
                if (sampleData.paging && sampleData.paging.next) { after = sampleData.paging.next.after; } else { break; }
            }
        }
        const fillCounts = {};
        if (recordsSample.length > 0) {
             recordsSample.forEach(r => Object.keys(r.properties).forEach(p => { if (r.properties[p] !== null && r.properties[p] !== '') fillCounts[p] = (fillCounts[p] || 0) + 1; }));
        }
        const auditResults = allProperties.map(prop => {
            const fillCountInSample = fillCounts[prop.name] || 0;
            const estimatedTotalFillCount = recordsSample.length > 0 ? Math.round((fillCountInSample / recordsSample.length) * totalRecords) : 0;
            const fillRate = totalRecords > 0 ? Math.round((estimatedTotalFillCount / totalRecords) * 100) : 0;
            return { label: prop.label, internalName: prop.name, type: prop.type, description: prop.description || '', isCustom: !prop.hubspotDefined, fillRate, fillCount: estimatedTotalFillCount };
        });
        const customProperties = auditResults.filter(p => p.isCustom);
        const averageCustomFillRate = customProperties.length > 0 ? Math.round(customProperties.reduce((acc, p) => acc + p.fillRate, 0) / customProperties.length) : 0;
        const propertiesWithZeroFillRate = auditResults.filter(p => p.fillRate === 0).length;
        res.json({ totalRecords, totalProperties: auditResults.length, averageCustomFillRate, propertiesWithZeroFillRate, properties: auditResults });
    } catch (error) {
        console.error(`Audit error for ${objectType}:`, error);
        res.status(500).json({ message: error.message });
    }
});

// NOTE: This is the logic from your previous project.
app.get('/api/data-health', async (req, res) => {
    const portalId = req.header('X-HubSpot-Portal-Id');
    if (!portalId) return res.status(400).json({ message: 'HubSpot Portal ID is missing.' });
    try {
        const accessToken = await getValidAccessToken(portalId);
        const orphanedContactsSearch = { filterGroups: [{ filters: [{ propertyName: 'associatedcompanyid', operator: 'NOT_HAS_PROPERTY' }] }], limit: 1 };
        const orphanedContactsRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', { method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(orphanedContactsSearch) });
        const orphanedContactsData = await orphanedContactsRes.json();
        const emptyCompaniesSearch = { filterGroups: [{ filters: [{ propertyName: 'num_associated_contacts', operator: 'EQ', value: 0 }] }], limit: 1 };
        const emptyCompaniesRes = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', { method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(emptyCompaniesSearch) });
        const emptyCompaniesData = await emptyCompaniesRes.json();
        const contactSampleRes = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts?limit=100&properties=email`, { headers: { 'Authorization': `Bearer ${accessToken}` }});
        const contactSampleData = await contactSampleRes.json();
        const emailCounts = (contactSampleData.results || []).reduce((acc, c) => { const email = c.properties.email?.toLowerCase(); if(email) acc[email] = (acc[email] || 0) + 1; return acc; }, {});
        const contactDuplicatesInSample = Object.values(emailCounts).filter(c => c > 1).length;
        const companySampleRes = await fetch(`https://api.hubapi.com/crm/v3/objects/companies?limit=100&properties=domain`, { headers: { 'Authorization': `Bearer ${accessToken}` }});
        const companySampleData = await companySampleRes.json();
        const domainCounts = (companySampleData.results || []).reduce((acc, c) => { const domain = c.properties.domain?.toLowerCase(); if(domain) acc[domain] = (acc[domain] || 0) + 1; return acc; }, {});
        const companyDuplicatesInSample = Object.values(domainCounts).filter(c => c > 1).length;
        res.json({ orphanedContacts: orphanedContactsData.total || 0, emptyCompanies: emptyCompaniesData.total || 0, contactDuplicatesInSample, companyDuplicatesInSample });
    } catch (error) {
        console.error("Data Health Audit Error:", error);
        res.status(500).json({ message: error.message });
    }
});

// NOTE: This is the logic from your previous project.
app.get('/api/data-health/details', async (req, res) => {
    const portalId = req.header('X-HubSpot-Portal-Id');
    const type = req.query.type;
    if (!portalId || !type) return res.status(400).json({ message: 'Portal ID and audit type are required.' });
    try {
        const accessToken = await getValidAccessToken(portalId);
        let searchBody = {};
        let objectType = '';
        if (type === 'orphanedContacts') {
            objectType = 'contacts';
            searchBody = { filterGroups: [{ filters: [{ propertyName: 'associatedcompanyid', operator: 'NOT_HAS_PROPERTY' }] }], limit: 20, properties: ['firstname', 'lastname', 'email', 'createdate'] };
        } else if (type === 'emptyCompanies') {
            objectType = 'companies';
            searchBody = { filterGroups: [{ filters: [{ propertyName: 'num_associated_contacts', operator: 'EQ', value: 0 }] }], limit: 20, properties: ['name', 'domain', 'createdate'] };
        } else {
            return res.status(400).json({ message: 'Invalid detail type requested.' });
        }
        const response = await fetch(`https://api.hubapi.com/crm/v3/objects/${objectType}/search`, { method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(searchBody), });
        if (!response.ok) throw new Error(`Failed to fetch details for ${type}`);
        const data = await response.json();
        res.json({ results: data.results });
    } catch (error) {
        console.error(`Drill-down error for ${type}:`, error);
        res.status(500).json({ message: error.message });
    }
});


app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`✅ Server is live on port ${PORT}`));

app.listen(PORT, () => console.log(`✅ Server is live on port ${PORT}`));
