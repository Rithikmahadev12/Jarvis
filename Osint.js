const puppeteer = require('puppeteer');

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

    const formattedQuery = cleanPhoneNumber(phoneNumber);
    let browser;
    
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/120.0.0.0 Safari/537.36');

        // --- PHASE 1: TARGETED SOCIAL MEDIA CRAWL ---
        // Tells the search engine to ONLY look for this phone number inside specific social networks
        const socialDork = `(site:facebook.com OR site:linkedin.com/in OR site:instagram.com) AND ${formattedQuery}`;
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(socialDork)}`;
        
        await page.goto(searchUrl, { waitUntil: 'networkidle2' });

        const socialResults = await page.evaluate(() => {
            const items = [];
            const elements = document.querySelectorAll('.result__snippet');
            const links = document.querySelectorAll('.result__url');
            
            elements.forEach((el, index) => {
                if(links[index]) {
                    items.push({
                        url: links[index].innerText.trim(),
                        snippet: el.innerText
                    });
                }
            });
            return items;
        });

        // --- PHASE 2: PROCESSING SOCIAL PROFILES ---
        let socialProfilesFound = [];
        let suspectedOwner = "Unknown Owner";
        let classifications = [];

        if (socialResults.length > 0) {
            for (const item of socialResults) {
                let platformName = "Unknown Platform";
                if (item.url.includes("facebook.com")) platformName = "Facebook";
                if (item.url.includes("linkedin.com")) platformName = "LinkedIn";
                if (item.url.includes("instagram.com")) platformName = "Instagram";

                socialProfilesFound.push({
                    platform: platformName,
                    link: item.url,
                    preview: item.snippet
                });

                // Try to isolate a profile identity name from the social snippet
                // Example: "Check out John Smith's profile on LinkedIn..."
                const nameMatch = item.preview.match(/([A-Z][a-z]+\s+[A-Z][a-z]+)/);
                if (nameMatch && suspectedOwner === "Unknown Owner") {
                    suspectedOwner = `${nameMatch[1]} (${platformName} Profile)`;
                }
            }
            classifications.push("Social Media Linked");
        }

        // --- PHASE 3: GENERAL FALLBACK IF SOCIAL CRALWER IS DRY ---
        if (suspectedOwner === "Unknown Owner") {
            const fallbackUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(formattedQuery)}`;
            await page.goto(fallbackUrl, { waitUntil: 'networkidle2' });

            const generalTitle = await page.evaluate(() => {
                const firstTitle = document.querySelector('.result__title');
                return firstTitle ? firstTitle.innerText : null;
            });

            if (generalTitle) {
                suspectedOwner = generalTitle.replace(/\|.*/, '').trim();
            }
        }

        await browser.close();

        return {
            success: true,
            number: phoneNumber,
            owner: suspectedOwner,
            spamRisk: socialProfilesFound.length > 0 ? "Low (Verified Social Profile)" : "Medium",
            tags: classifications.length > 0 ? classifications : ["Personal Line"],
            socialMatches: socialProfilesFound
        };

    } catch (error) {
        if (browser) await browser.close();
        console.error("OSINT Social Lookup Error:", error);
        return { success: false, error: "Internal processing engine timeout." };
    }
}

module.exports = { reversePhoneLookup };
