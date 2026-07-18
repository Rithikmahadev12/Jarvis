// Upgrade to the stealth-enabled orchestration framework
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

function cleanPhoneNumber(phoneStr) {
    return ('' + phoneStr).replace(/\D/g, '');
}

// Updated function signature to accept an optional target name
async function reversePhoneLookup(phoneNumber, targetName = '') {
    if (!phoneNumber) {
        return { success: false, error: "No phone number provided." };
    }

    const cleanedRaw = cleanPhoneNumber(phoneNumber);
    const formats = [
        cleanedRaw,                                      
        `${cleanedRaw.slice(0, 3)}-${cleanedRaw.slice(3, 6)}-${cleanedRaw.slice(6)}`, 
        `(${cleanedRaw.slice(0, 3)}) ${cleanedRaw.slice(3, 6)}-${cleanedRaw.slice(6)}`
    ];

    let browser;
    let socialMatches = [];
    let generalResults = [];
    
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,800'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        // --- OPTIMIZED PHASE 1: SEARCH BY NAME IF PROVIDED ---
        if (targetName && targetName.trim().length > 0) {
            const cleanName = targetName.trim();
            // Target the name on Instagram specifically, using Google's broad index
            const nameDork = `site:instagram.com "${cleanName}"`;
            const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(nameDork)}&hl=en`;
            
            await page.goto(googleUrl, { waitUntil: 'networkidle2' });
            await new Promise(r => setTimeout(r, 1000));

            socialMatches = await page.evaluate(() => {
                const results = [];
                const modules = document.querySelectorAll('#search .g');
                
                modules.forEach(mod => {
                    const titleEl = mod.querySelector('h3');
                    const linkEl = mod.querySelector('a');
                    const snippetEl = mod.querySelector('[style*="-webkit-line-clamp"], .VwiC3b');
                    
                    if (titleEl && linkEl) {
                        const linkText = linkEl.href || '';
                        if (linkText.includes('instagram.com')) {
                            results.push({
                                platform: "Instagram",
                                title: titleEl.innerText.trim(),
                                snippet: snippetEl ? snippetEl.innerText.trim() : '',
                                link: linkText
                            });
                        }
                    }
                });
                return results;
            });
        }

        // --- PHASE 2: FALLBACK TO PHONE NUMBER DORK IF NO NAME MATCHES ---
        if (socialMatches.length === 0) {
            const googleDork = `(site:instagram.com OR site:facebook.com OR site:linkedin.com) "${formats[1]}"`;
            const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(googleDork)}&hl=en`;
            
            await page.goto(googleUrl, { waitUntil: 'networkidle2' });
            await new Promise(r => setTimeout(r, 1000));

            const phoneMatches = await page.evaluate(() => {
                const results = [];
                const modules = document.querySelectorAll('#search .g');
                
                modules.forEach(mod => {
                    const titleEl = mod.querySelector('h3');
                    const linkEl = mod.querySelector('a');
                    const snippetEl = mod.querySelector('[style*="-webkit-line-clamp"], .VwiC3b');
                    
                    if (titleEl && linkEl) {
                        const linkText = linkEl.href || '';
                        let platform = "Social Profile";
                        if (linkText.includes('instagram.com')) platform = "Instagram";
                        else if (linkText.includes('facebook.com')) platform = "Facebook";
                        else if (linkText.includes('linkedin.com')) platform = "LinkedIn";

                        results.push({
                            platform: platform,
                            title: titleEl.innerText.trim(),
                            snippet: snippetEl ? snippetEl.innerText.trim() : '',
                            link: linkText
                        });
                    }
                });
                return results;
            });
            socialMatches.push(...phoneMatches);
        }

        await browser.close();

        // --- PHASE 3: PARSING LOGIC ENGINE ---
        let suspectedOwner = targetName || "Unknown / Unlisted Name";
        let riskScore = "Low";
        let classifications = [];

        if (socialMatches.length > 0) {
            classifications.push(`Social Footprints Isolated (${socialMatches.length})`);
            
            // If we didn't have a name initially, extract it from the found profile
            if (!targetName) {
                let cleanedTitle = socialMatches[0].title
                    .replace(/(@\w+)/g, '$1') 
                    .split(/[|•\-(]/)[0]
                    .trim();
                
                if (cleanedTitle && !/^(instagram|facebook|linkedin|login|sign up)/i.test(cleanedTitle)) {
                    suspectedOwner = `${cleanedTitle} (${socialMatches[0].platform})`;
                }
            }
        }

        return {
            success: true,
            number: phoneNumber,
            owner: suspectedOwner,
            spamRisk: riskScore,
            tags: classifications.length > 0 ? classifications : ["Personal Line"],
            socialMatches: socialMatches
        };

    } catch (error) {
        if (browser) await browser.close();
        console.error("OSINT Pipeline Exception:", error);
        return { success: false, error: "Scraping pipeline execution failure." };
    }
}

module.exports = { reversePhoneLookup };
