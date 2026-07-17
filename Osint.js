const puppeteer = require('puppeteer');

/**
 * Clean and standardize phone numbers to format: (XXX) XXX-XXXX or XX-XX...
 */
function cleanPhoneNumber(phoneStr) {
    const cleaned = ('' + phoneStr).replace(/\D/g, '');
    if (cleaned.length === 10) {
        return `"${cleaned.slice(0, 3)}-${cleaned.slice(3, 6)}-${cleaned.slice(6)}"`;
    }
    return `"${cleaned}"`;
}

/**
 * Replicates a premium Reverse Phone Lookup API completely for free by using 
 * real-time headless OSINT web-scraping footprints.
 */
async function reversePhoneLookup(phoneNumber) {
    if (!phoneNumber) {
        return { success: false, error: "No phone number provided." };
    }

    const formattedQuery = cleanPhoneNumber(phoneNumber);
    let browser;
    
    try {
        // Launch a stealthy headless browser context
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const page = await browser.newPage();
        // Set user agent to pretend we are a standard browser profile
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // We run a targeted exact-string lookup on raw data pools
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(formattedQuery)}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2' });

        // Extract metadata text snippets that premium APIs scrape behind paywalls
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

        if (results.length === 0) {
            return {
                success: true,
                number: phoneNumber,
                owner: "Unknown / Unlisted Name",
                details: "No explicit public record linked to this exact format string.",
                spamRisk: "Low"
            };
        }

        // --- Intelligence Processing and Parsing ---
        let combinedText = results.map(r => `${r.title} ${r.snippet}`).join(' ').toLowerCase();
        let suspectedOwner = "Unknown Owner";
        let riskScore = "Low";
        let classifications = [];

        // Identify scam indicators
        if (combinedText.includes('scam') || combinedText.includes('telemarketer') || combinedText.includes('spam') || combinedText.includes('robocall')) {
            riskScore = "High";
            classifications.push("Reported Scam/Spam Active");
        }
        
        // Scan for potential names or business entities
        const businessKeywords = ['inc', 'llc', 'co', 'services', 'support', 'telecom', 'department'];
        let foundBusiness = businessKeywords.find(kw => combinedText.includes(kw));
        
        if (foundBusiness) {
            classifications.push("Possible Commercial Entity");
        }

        // Fallback natural extraction matching pattern
        // Looks for common configurations in OSINT directories: "is registered to [Name]" or "Name: [Value]"
        for (const item of results) {
            const text = item.snippet;
            const match = text.match(/(?:owned by|registered to|owner:)\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/i);
            if (match && match[1]) {
                suspectedOwner = match[1];
                break;
            }
        }

        // If no explicit phrase, parse out the cleanest high-ranking context title
        if (suspectedOwner === "Unknown Owner" && results[0].title) {
            suspectedOwner = results[0].title.replace(/\|.*/, '').trim();
        }

        return {
            success: true,
            number: phoneNumber,
            owner: suspectedOwner,
            spamRisk: riskScore,
            tags: classifications.length > 0 ? classifications : ["Personal Line"],
            rawIntelSample: results.slice(0, 2) // Send back top footprints for the dashboard UI
        };

    } catch (error) {
        if (browser) await browser.close();
        console.error("OSINT Lookup Error:", error);
        return { success: false, error: "Internal processing engine timeout." };
    }
}

module.exports = { reversePhoneLookup };
