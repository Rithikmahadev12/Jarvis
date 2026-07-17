// Upgrade to the stealth-enabled orchestration framework
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

function cleanPhoneNumber(phoneStr) {
    const cleaned = ('' + phoneStr).replace(/\D/g, '');
    if (cleaned.length === 10) {
        return `"${cleaned.slice(0, 3)}-${cleaned.slice(3, 6)}-${cleaned.slice(6)}"`;
    }
    return `"${cleaned}"`;
}

async function reversePhoneLookup(phoneNumber) {
    if (!phoneNumber) {
        return { success: false, error: "No phone number provided." };
    }

    const cleanedRaw = ('' + phoneNumber).replace(/\D/g, '');
    const formattedQuery = cleanPhoneNumber(phoneNumber);
    let browser;
    
    try {
        // Launches a human-masked Chromium execution pool
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const page = await browser.newPage();
        
        // Emulate a standard verified Windows Chrome user profile layout
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9'
        });

        let socialMatches = [];
        let classifications = [];

        // --- PHASE 1: EXPANDED SOCIAL MEDIA SEARCH ---
        if (cleanedRaw.length >= 7) {
            // Re-engineered cross-platform lookup pattern (handles raw strings, formatting, and international formats)
            const socialDork = `(site:instagram.com OR site:facebook.com OR site:linkedin.com) AND ("${cleanedRaw}" OR ${formattedQuery} OR "+1${cleanedRaw}")`;
            const socialSearchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(socialDork)}`;
            
            await page.goto(socialSearchUrl, { waitUntil: 'networkidle2' });

            socialMatches = await page.evaluate(() => {
                const profiles = [];
                const snippets = document.querySelectorAll('.result__snippet');
                const titles = document.querySelectorAll('.result__title');
                const links = document.querySelectorAll('.result__url');
                
                snippets.forEach((el, index) => {
                    const titleText = titles[index] ? titles[index].innerText : '';
                    const snippetText = el.innerText;
                    const urlText = links[index] ? links[index].innerText : '';
                    
                    let platform = "Social Profile";
                    if (urlText.includes('instagram.com') || snippetText.toLowerCase().includes('instagram')) platform = "Instagram";
                    else if (urlText.includes('facebook.com') || snippetText.toLowerCase().includes('facebook')) platform = "Facebook";
                    else if (urlText.includes('linkedin.com') || snippetText.toLowerCase().includes('linkedin')) platform = "LinkedIn";

                    profiles.push({
                        platform: platform,
                        title: titleText,
                        snippet: snippetText,
                        link: urlText
                    });
                });
                return profiles;
            });
        }

        // --- PHASE 2: PUBLIC RECORD FOOTPRINT SEARCH ---
        const generalSearchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(formattedQuery)}`;
        await page.goto(generalSearchUrl, { waitUntil: 'networkidle2' });

        const results = await page.evaluate(() => {
            const snippets = [];
            const elements = document.querySelectorAll('.result__snippet');
            const titles = document.querySelectorAll('.result__title');
            
            elements.forEach((el, index) => {
                snippets.push({
                    title: titles[index] ? titles[index].innerText : '',
                    snippet: el.innerText
                });
            });
            return snippets;
        });

        await browser.close();

        // Check if bot detection still blocked both passes completely
        if (results.length === 0 && socialMatches.length === 0) {
            return {
                success: false,
                error: "The search index throttled the automation request. Try checking your local IP or network restrictions."
            };
        }

        // --- PHASE 3: PARSING LOGIC ENGINE ---
        if (socialMatches.length > 0) {
            classifications.push(`Social Footprints Isolated (${socialMatches.length})`);
        }

        let combinedText = [...results, ...socialMatches].map(r => `${r.title} ${r.snippet}`).join(' ').toLowerCase();
        let suspectedOwner = "Unknown Owner";
        let riskScore = "Low";

        if (combinedText.includes('scam') || combinedText.includes('telemarketer') || combinedText.includes('spam')) {
            riskScore = "High";
            classifications.push("Reported Spam Active");
        }

        // Attempt identity extraction from matching profiles
        for (const profile of socialMatches) {
            const match = profile.title.match(/^([^|•\-(]+)/);
            if (match && match[1] && !match[1].toLowerCase().includes('instagram') && !match[1].toLowerCase().includes('facebook')) {
                suspectedOwner = match[1].trim() + ` (${profile.platform})`;
                break;
            }
        }

        if (suspectedOwner === "Unknown Owner") {
            for (const item of results) {
                const match = item.snippet.match(/(?:owned by|registered to|owner:)\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/i);
                if (match && match[1]) {
                    suspectedOwner = match[1];
                    break;
                }
            }
        }

        if (suspectedOwner === "Unknown Owner" && results.length > 0) {
            suspectedOwner = results[0].title.replace(/\|.*/, '').trim();
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
        console.error("Stealth OSINT Engine Exception:", error);
        return { success: false, error: "Scraping pipeline execution failure." };
    }
}

module.exports = { reversePhoneLookup };
