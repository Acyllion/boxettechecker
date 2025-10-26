const express = require("express");
const puppeteer = require("puppeteer");
const cors = require("cors");
const { Cluster } = require("puppeteer-cluster");
const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
// Serve the index.html from the root directory
app.use(express.static(__dirname));

// Configuration
const config = {
  maxConcurrent: 80,
  timeout: 15000,
  retries: 1,
};

// Global cluster
let cluster;

async function initCluster() {
  console.log("Initializing Puppeteer Cluster...");
  cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_PAGE,
    maxConcurrency: config.maxConcurrent,
    puppeteerOptions: {
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
    timeout: config.timeout,
    retryLimit: config.retries,
  });

  await cluster.task(async ({ page, data: code }) => {
    try {
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        ["image", "stylesheet", "font"].includes(req.resourceType())
          ? req.abort()
          : req.continue();
      });

      await page.goto("https://www.rs.ge/ParcelSearch?cat=5&tab=1", {
        waitUntil: "domcontentloaded",
        timeout: config.timeout,
      });

      const token = await page.$eval(
        'input[name="__RequestVerificationToken"]',
        (el) => el.value
      );

      const response = await page.evaluate(
        async (code, token) => {
          const res = await fetch(
            "https://www.rs.ge/RsGe.Module/CargoVehicles/getSearchResults",
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/x-www-form-urlencoded; charset=UTF-8",
                Referer: "https://www.rs.ge/ParcelSearch?cat=5&tab=1",
              },
              body: `searchType=6&searchValue=${encodeURIComponent(
                code
              )}&ena=geo&__RequestVerificationToken=${token}`,
            }
          );
          return await res.json();
        },
        code,
        token
      );

      if (!response?.Data?.Rows?.length) {
        return { trackingCode: code, hasRsData: false };
      }

      const result = {
        trackingCode: code,
        hasRsData: true,
        status: "In Georgia (Processing)",
      };

      response.Data.Fields.forEach((field, i) => {
        if (!["ID", "GR_ID", "UN_ID"].includes(field)) {
          result[field] = response.Data.Rows[0][i];
        }
      });

      return result;
    } catch (error) {
      console.error(`Error processing tracking code ${code} on RS.ge:`, error);
      throw error;
    }
  });
  console.log("Puppeteer Cluster initialized successfully.");
}

initCluster().catch((err) =>
  console.error("Failed to initialize cluster:", err)
);

const parseShipments = async (page, url, defaultStatus) => {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const parcelSelector = "tbody tr";

    await page.waitForSelector(parcelSelector, { timeout: 3000 }).catch(() => {
      return [];
    });

    // Get all parcel rows
    const rows = await page.$$(parcelSelector);
    const parcels = [];

    for (let i = 0; i < rows.length; i++) {
      try {
        // Extract tracking code and estimated arrival from the row
        const rowData = await rows[i]
          .evaluate((row) => {
            const trackingCode = row
              .querySelector("td:nth-child(2) span")
              ?.textContent.trim();

            // Extract estimated arrival date - look in all table cells
            let estimatedArrival = null;
            const allText = row.textContent;

            // Match pattern like "Ожидаемое прибытие 2025-10-29" or just "2025-10-29"
            const dateMatch = allText.match(/(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) {
              estimatedArrival = dateMatch[1];
            }

            return { trackingCode, estimatedArrival };
          })
          .catch(() => ({ trackingCode: null, estimatedArrival: null }));

        if (
          !rowData.trackingCode ||
          !/^[A-Z0-9]{6,}$/i.test(rowData.trackingCode)
        ) {
          continue;
        }

        const trackingCode = rowData.trackingCode;
        const estimatedArrival = rowData.estimatedArrival;

        // Click on the row to open modal
        await rows[i].click();

        // Wait for modal to appear with proper selector
        await page
          .waitForSelector("p.text-sm.font-semibold.text-black", {
            timeout: 1000,
          })
          .catch(() => {});

        // Additional wait for modal content to fully render
        await new Promise((resolve) => setTimeout(resolve, 400));

        // Extract description from modal with retry logic
        let description = "Parcel";
        try {
          description = await page.evaluate(() => {
            const lis = Array.from(document.querySelectorAll("li"));

            const descLi = lis.find((li) => {
              const flexCol = li.querySelector("div.flex.flex-col");
              if (flexCol) {
                const p = flexCol.querySelector(
                  "p.text-sm.font-semibold.text-black"
                );
                if (p) {
                  const text = p.textContent.trim();
                  return text === "Описание" || text.includes("Описание");
                }
              }
              return false;
            });

            if (descLi) {
              const flexCol = descLi.querySelector("div.flex.flex-col");
              const descP = flexCol.querySelector("p.text-sm.font-medium");
              if (descP) {
                return descP.textContent.trim();
              }
            }
            return null;
          });

          if (!description) {
            description = "Parcel";
          }
        } catch (evalError) {
          description = "Parcel";
        }

        parcels.push({
          trackingCode: trackingCode,
          packageName: description,
          status: defaultStatus,
          estimatedArrival: estimatedArrival,
        });

        // Close modal
        await page.click("div.flex.h-10.w-10.cursor-pointer").catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Remove this line entirely
      } catch (error) {
        console.error(`Error extracting parcel ${i + 1}:`, error.message);
        // Add the parcel with default description if extraction failed


        parcels.push({
          trackingCode: rowData.trackingCode,
          packageName: "Parcel",
          status: defaultStatus,
          estimatedArrival: rowData.estimatedArrival,
        });

        // Try to close modal if it's open
        try {
          await page.click("div.flex.h-10.w-10.cursor-pointer").catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch {}
      }
    }

    return parcels;
  } catch (error) {
    console.error(`Error parsing shipments from ${url}:`, error.message);
    return [];
  }
};

app.post("/check", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  let browser;
  try {
    console.log("Launching browser for Boxette login...");
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox"],
    });

    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(config.timeout);

    console.log("Navigating to Boxette login page...");
await page.goto("https://profile1.boxette.ge/log-in", {
  waitUntil: "domcontentloaded",
});

    await page.waitForSelector('input[name="email"]', { visible: true });
    await page.type('input[name="email"]', email);
    await page.type('input[name="password"]', password);

    console.log("Submitting login form...");
await Promise.all([
  page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }),
  page.click("button[type='submit']"),
]);

    const currentUrl = page.url();
    if (currentUrl.includes("/log-in")) {
      return res.status(401).json({
        error: "Authentication failed. Please check your email and password.",
      });
    }
    console.log("Login successful!");

    // --- If login is successful, proceed to parse all shipment categories ---

    const shippedShipments = await parseShipments(
      page,
      "https://profile1.boxette.ge/parcels/get-parcel/in-transit",
      "Sent to Georgia"
    );

    const expectedShipments = await parseShipments(
      page,
      "https://profile1.boxette.ge/parcels/get-parcel/expected-parcels",
      "Not Arrived"
    );

    const receivedShipments = await parseShipments(
      page,
      "https://profile1.boxette.ge/parcels/get-parcel/warehouse",
      "In the Warehouse"
    );

    const allShipments = [
      ...shippedShipments,
      ...expectedShipments,
      ...receivedShipments,
    ];

    if (!allShipments.length) {
      console.log("No shipments found for this account across all categories.");
      return res.json([]);
    }

    console.log(
      `Found ${allShipments.length} total shipments. Checking status on RS.ge for those in transit...`
    );

    const results = await Promise.all(
      allShipments.map((item) => {
        if (item.status === "Sent to Georgia") {
          return cluster
            .execute(item.trackingCode)
            .then((rsData) => {
              if (rsData.hasRsData) {
                // Has RS.ge data, so it's in Georgia
                return {
                  ...item,
                  ...rsData,
                  status: "In Georgia (Processing)",
                };
              } else {
                // No RS.ge data yet, still in transit
                return { ...item, status: "Sent to Georgia" };
              }
            })
            .catch((error) => ({
              ...item,
              status: "Error",
              details: error.message,
            }));
        }
        return Promise.resolve(item);
      })
    );

    res.json(results);
  } catch (error) {
    console.error("An unexpected error occurred:", error);
    res
      .status(500)
      .json({ error: "An internal server error occurred: " + error.message });
  } finally {
    if (browser) {
      console.log("Closing browser.");
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on 192.168.0.104:${PORT}`);
});
