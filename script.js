// ==========================================
// LPG POS - MAIN JAVASCRIPT
// ==========================================


// ==========================================
// STORAGE
// ==========================================

const STORAGE = {

    products: "lpgPosProduct",
    customers: "lpgPosCustomers",
    vendors: "lpgPosVendors",
    purchases: "lpgPosPurchases",
    sales: "lpgPosSales",
    invoices: "lpgPosInvoices",
    returns: "lpgPosReturns",
    sellers: "lpgPosSellers",
    settings: "lpgPosSettings",
    users: "companyUsers",
    inventoryMovements: "lpgPosInventoryMovements",
    shifts: "lpgPosTillShifts",
    expenses: "lpgPosExpenses",
    audit: "lpgPosAuditLog"

};

const CLOUD_STORAGE_KEYS = {
    url: "lpgPosSupabaseUrl",
    anonKey: "lpgPosSupabaseAnonKey"
};

function getCloudConfig() {
    const url = String(localStorage.getItem(CLOUD_STORAGE_KEYS.url) || "").trim();
    const anonKey = String(localStorage.getItem(CLOUD_STORAGE_KEYS.anonKey) || "").trim();
    return {
        url,
        anonKey,
        enabled: Boolean(url && anonKey && url.startsWith("https://"))
    };
}

async function syncCloudFromRemote(type) {
    const { url, anonKey, enabled } = getCloudConfig();
    if (!enabled) return;

    const key = STORAGE[type];
    if (!key) return;

    try {
        const response = await fetch(`${url}/rest/v1/${key}?select=*`, {
            method: "GET",
            headers: {
                apikey: anonKey,
                Authorization: `Bearer ${anonKey}`,
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) {
            throw new Error(`Cloud read failed for ${type}: ${response.status}`);
        }

        const remoteData = await response.json();
        if (Array.isArray(remoteData)) {
            localStorage.setItem(key, JSON.stringify(remoteData));
        }
    } catch (error) {
        console.warn("Cloud sync read skipped:", error);
    }
}

async function syncCloudToRemote(type, data) {
    const { url, anonKey, enabled } = getCloudConfig();
    if (!enabled) return;

    const key = STORAGE[type];
    if (!key) return;

    try {
        const response = await fetch(`${url}/rest/v1/${key}?on_conflict=id`, {
            method: "POST",
            headers: {
                apikey: anonKey,
                Authorization: `Bearer ${anonKey}`,
                "Content-Type": "application/json",
                Prefer: "resolution=merge-duplicates"
            },
            body: JSON.stringify(Array.isArray(data) ? data : [data])
        });

        if (!response.ok) {
            throw new Error(`Cloud write failed for ${type}: ${response.status}`);
        }
    } catch (error) {
        console.warn("Cloud sync write skipped:", error);
    }
}

function syncCloudStateOnStartup() {
    Object.keys(STORAGE).forEach(type => syncCloudFromRemote(type));
}

function setCloudConfig(url, anonKey) {
    const cleanUrl = String(url || "").trim();
    const cleanKey = String(anonKey || "").trim();

    if (!cleanUrl || !cleanKey) {
        localStorage.removeItem(CLOUD_STORAGE_KEYS.url);
        localStorage.removeItem(CLOUD_STORAGE_KEYS.anonKey);
        return false;
    }

    localStorage.setItem(CLOUD_STORAGE_KEYS.url, cleanUrl);
    localStorage.setItem(CLOUD_STORAGE_KEYS.anonKey, cleanKey);
    syncCloudStateOnStartup();
    return true;
}


// ==========================================
// GET DATA
// ==========================================

function getData(type) {

    const key = STORAGE[type];

    if (!key) {
        return [];
    }

    try {

        const data = JSON.parse(
            localStorage.getItem(key) || "[]"
        );

        if (isAdmin() || !isLoggedIn()) {
            return data;
        }

        const company = getCurrentUser()?.username;
        return data.filter(item => item.companyId === company);

    } catch (error) {

        console.error(
            "Storage error:",
            error
        );

        return [];

    }

}


// ==========================================
// SAVE DATA
// ==========================================

function saveData(type, data, options = {}) {

    const key = STORAGE[type];

    if (!key) {
        return;
    }

    if (!options.systemUpdate && !canEditData(type, data)) {
        return false;
    }

    if (isAdmin() || !isLoggedIn()) {
        localStorage.setItem(key, JSON.stringify(data));
        syncCloudToRemote(type, data);
        return true;
    }

    const company = getCurrentUser()?.username;
    const allData = JSON.parse(localStorage.getItem(key) || "[]");
    const companyData = data.map(item => ({ ...item, companyId: company }));
    const otherCompanyData = allData.filter(item => item.companyId !== company);
    localStorage.setItem(key, JSON.stringify([...otherCompanyData, ...companyData]));
    syncCloudToRemote(type, [...otherCompanyData, ...companyData]);

    return true;

}


// ==========================================
// ADD DATA
// ==========================================

function addData(type, item) {

    const data = getData(type);

    data.push(item);

    saveData(type, data);

    return item;

}

function recordAudit(action, details = {}) {
    const entries = getData("audit");
    entries.push({
        id: generateId("AUD"),
        action,
        details,
        operator: getCurrentUser()?.username || "Unknown",
        date: new Date().toISOString()
    });
    saveData("audit", entries);
}

function getOpenShift(till) {
    return getData("shifts").find(shift => shift.till === till && shift.status === "open");
}

function openTill(till, openingCash, openingKg = 0) {
    if (!till || getOpenShift(till)) return false;
    const shifts = getData("shifts");
    const shift = {
        id: generateId("SHIFT"),
        till,
        openingCash: Number(openingCash || 0),
        openingKg: Number(openingKg || 0),
        openedBy: getCurrentUser()?.username || "Unknown",
        openedAt: new Date().toISOString(),
        status: "open"
    };
    shifts.push(shift);
    saveData("shifts", shifts);
    recordAudit("till_opened", shift);
    return shift;
}

function closeTill(till, closingCash, closingKg = 0) {
    const shifts = getData("shifts");
    const index = shifts.findIndex(shift => shift.till === till && shift.status === "open");
    if (index === -1) return false;
    const shift = shifts[index];
    const sales = getData("sales").filter(sale => sale.till === till && sale.dispatchedAt >= shift.openedAt);
    shift.expectedCash = shift.openingCash + sales.filter(sale => (sale.payment || "Cash") === "Cash")
        .reduce((sum, sale) => sum + Number(sale.total || 0), 0);
    shift.closingCash = Number(closingCash || 0);
    shift.variance = shift.closingCash - shift.expectedCash;
    shift.closingKg = Number(closingKg || 0);
    shift.kgVariance = shift.closingKg - Number(shift.openingKg || 0);
    shift.closedBy = getCurrentUser()?.username || "Unknown";
    shift.closedAt = new Date().toISOString();
    shift.status = "closed";
    shifts[index] = shift;
    saveData("shifts", shifts);
    recordAudit("till_closed", shift);
    return shift;
}

function recordInventoryMovement(product, quantity, type, reference) {
    const movements = getData("inventoryMovements");
    movements.push({
        id: generateId("MOV"),
        product,
        quantity: Number(quantity || 0),
        type,
        reference,
        operator: getCurrentUser()?.username || "Unknown",
        date: new Date().toISOString()
    });
    saveData("inventoryMovements", movements);
    recordAudit("inventory_movement", movements[movements.length - 1]);

    const products = getData("products");
    const normalizeProductText = value => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    const search = normalizeProductText(product);
    const matchedProduct = products.find(item => {
        const values = [item.name, item.size, item.waybillNumber, item.truckNumber]
            .map(normalizeProductText)
            .filter(Boolean);
        return values.some(value => value === search || value.includes(search) || search.includes(value));
    });
    if (matchedProduct) {
        matchedProduct.stock = Number(matchedProduct.stock || 0) + Number(quantity || 0);
        matchedProduct.stockBroughtIn = Number(matchedProduct.stockBroughtIn || 0);
        matchedProduct.stockSold = Number(matchedProduct.stockSold || 0);
        if (type === "purchase") {
            matchedProduct.stockBroughtIn = Number(matchedProduct.stockBroughtIn || 0) + Number(quantity || 0);
        }
        if (type === "sale") {
            matchedProduct.stockSold = Number(matchedProduct.stockSold || 0) + Math.abs(Number(quantity || 0));
        }
        saveData("products", products, { systemUpdate: true });
    }
}


// ==========================================
// UPDATE DATA
// ==========================================

function updateData(type, id, changes) {

    if (!isAdmin()) {
        return false;
    }

    const data = getData(type);

    const index =
        data.findIndex(
            item =>
                String(item.id) === String(id)
        );


    if (index === -1) {
        return false;
    }


    data[index] = {

        ...data[index],

        ...changes

    };


    saveData(type, data);

    return data[index];

}


// ==========================================
// DELETE DATA
// ==========================================

function deleteData(type, id) {

    if (!isAdmin()) {
        return getData(type);
    }

    const data = getData(type);


    const filtered =
        data.filter(
            item =>
                String(item.id) !== String(id)
        );


    saveData(
        type,
        filtered
    );


    return filtered;

}


// ==========================================
// GENERATE ID
// ==========================================

function generateId(prefix = "ID") {

    return (
        prefix +
        "-" +
        Date.now() +
        "-" +
        Math.random()
            .toString(36)
            .substring(2, 7)
            .toUpperCase()
    );

}


// ==========================================
// MONEY
// ==========================================

function formatMoney(amount) {

    return (
        "₦" +
        Number(amount || 0)
            .toLocaleString(
                "en-NG",
                {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                }
            )
    );

}


// ==========================================
// DATE
// ==========================================

function formatDate(date) {

    return new Date(
        date || Date.now()
    ).toLocaleDateString(
        "en-NG",
        {
            year: "numeric",
            month: "short",
            day: "numeric"
        }
    );

}

function formatDateTime(date) {
    return `${formatDate(date)} ${new Date(date || Date.now()).toLocaleTimeString("en-NG", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    })}`;
}


// ==========================================
// ESCAPE HTML
// ==========================================

function escapeHTML(value) {

    return String(
        value ?? ""
    )
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

}


// ==========================================
// SETTINGS
// ==========================================

function getSettings() {

    try {

        return JSON.parse(
            localStorage.getItem(
                STORAGE.settings
            ) || "{}"
        );

    } catch {

        return {};

    }

}

function printReceipt(record, type) {
    const settings = getSettings();
    const businessName = settings.businessName?.trim() === "mikel gas" || !settings.businessName?.trim()
        ? "Gas Trade"
        : settings.businessName;
    const isSale = type === "sales";
    const reference = isSale ? record.transactionId : record.invoiceId;
    const description = isSale ? record.description : record.customer;
    const date = isSale ? record.dispatchedAt : record.date;
    const header = settings.receiptHeader || "Receipt";
    const footer = settings.receiptFooter || "Hope you had a nice day";
    const existingReceipt = document.getElementById("pos-print-receipt");
    existingReceipt?.remove();
    const receipt = document.createElement("main");
    receipt.id = "pos-print-receipt";
    receipt.innerHTML = `
                <h1>${escapeHTML(businessName)}</h1>
                ${settings.showPhone && settings.businessPhone ? `<p class="message">${escapeHTML(settings.businessPhone)}</p>` : ""}
                ${settings.showAddress && settings.businessAddress ? `<p class="message">${escapeHTML(settings.businessAddress)}</p>` : ""}
                <p class="message">${escapeHTML(header).replace(/\n/g, "<br>")}</p>
                <div class="rule"></div>
                <div class="line"><span class="label">${isSale ? "Transaction" : "Invoice"}</span><span>${escapeHTML(reference || "-")}</span></div>
                <div class="line"><span class="label">${isSale ? "Description" : "Customer"}</span><span>${escapeHTML(description || "-")}</span></div>
                ${isSale ? `<div class="line"><span class="label">Quantity</span><span>${escapeHTML(record.quantity || "-")}</span></div>` : ""}
                ${isSale ? `<div class="line"><span class="label">Till</span><span>${escapeHTML(record.till || "-")}</span></div>` : ""}
                ${isSale ? `<div class="line"><span class="label">Operator</span><span>${escapeHTML(record.operator || "-")}</span></div>` : ""}
                <div class="line"><span class="label">Payment</span><span>${escapeHTML(record.payment || "-")}</span></div>
                <div class="line"><span class="label">Date</span><span>${escapeHTML(date ? formatDate(date) : "-")}</span></div>
                <div class="rule"></div>
                <div class="line total"><span>Total</span><span>${escapeHTML(formatMoney(record.total || 0))}</span></div>
                <p class="footer">${escapeHTML(footer).replace(/\n/g, "<br>")}</p>
    `;
    document.body.appendChild(receipt);
    document.body.classList.add("receipt-printing");
    const cleanUp = () => {
        document.body.classList.remove("receipt-printing");
        receipt.remove();
        window.removeEventListener("afterprint", cleanUp);
    };
    window.addEventListener("afterprint", cleanUp);
    setTimeout(() => window.print(), 100);
}


function saveSettings(settings) {

    if (isLoggedIn() && !isAdmin()) {
        return false;
    }

    localStorage.setItem(
        STORAGE.settings,
        JSON.stringify(settings)
    );

    return true;

}


// ==========================================
// LOGIN
// ==========================================

function isLoggedIn() {

    return (
        sessionStorage.getItem(
            "lpgPosLoggedIn"
        ) === "true"
    );

}


function getCurrentUser() {

    try {

        return JSON.parse(
            sessionStorage.getItem(
                "currentCompanyUser"
            ) || "null"
        );

    } catch {

        return null;

    }

}

function getCurrentRole() {
    const user = getCurrentUser();
    if (user?.role === "admin" || user?.username === "admin") return "admin";
    if (user?.role === "driver") return "driver";
    return "input";
}

function isAdmin() {
    return getCurrentRole() === "admin";
}

function canEditData(type, data) {
    if (isAdmin() || !isLoggedIn()) {
        return true;
    }

    if (type === "settings" || type === "users") {
        return false;
    }

    const existingData = getData(type);
    if (data.length < existingData.length) {
        return false;
    }

    const existingIds = new Set(existingData.map(item => String(item.id)));
    return data.filter(item => existingIds.has(String(item.id)))
        .every(item => JSON.stringify(item) === JSON.stringify(existingData.find(existing => String(existing.id) === String(item.id))));
}


function logoutUser() {

    sessionStorage.removeItem(
        "lpgPosLoggedIn"
    );

    sessionStorage.removeItem(
        "currentCompanyUser"
    );

    localStorage.removeItem("lpgPosLoggedIn");
    localStorage.removeItem("currentCompanyUser");

    window.location.href =
        "index.html";

}

function handleLogin(event) {
    event.preventDefault();

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    const errorElement = document.getElementById("loginError");

    const users = [
        { username: "admin", password: "M!kelGas#26", role: "admin" },
        { username: "company01", password: "Lpg!Gas#01", role: "input" },
        { username: "company02", password: "Lpg@Gas#02", role: "input" },
        { username: "company03", password: "Lpg#Gas@03", role: "input" },
        { username: "company04", password: "Lpg$Gas#04", role: "input" },
        { username: "company05", password: "Lpg%Gas#05", role: "input" },
        { username: "company06", password: "Lpg&Gas#06", role: "input" },
        { username: "company07", password: "Lpg*Gas#07", role: "input" },
        { username: "company08", password: "Lpg+Gas#08", role: "input" },
        { username: "company09", password: "Lpg=Gas#09", role: "input" },
        { username: "company10", password: "Lpg?Gas#10", role: "input" },
        { username: "company11", password: "Lpg!Gas@11", role: "input" },
        { username: "gastrade", password: "GasTrade#12", role: "input" },
        { username: "driver", password: "Driver@Gas1", role: "driver" }
    ];
    const matchedUser = users.find(user => user.username === username && user.password === password);

    if (!matchedUser) {
        errorElement.textContent = "Incorrect username or password.";
        return;
    }

    const currentHour = new Date().getHours();
    if (matchedUser.role === "input" && (currentHour < 7 || currentHour >= 22)) {
        errorElement.textContent = "Company login is available from 7:00 AM to 10:00 PM.";
        return;
    }

    if (matchedUser.role !== "admin") {
        const notifications = JSON.parse(localStorage.getItem("lpgPosLoginNotifications") || "[]");
        notifications.push({
            username: matchedUser.username,
            time: new Date().toISOString()
        });
        localStorage.setItem("lpgPosLoginNotifications", JSON.stringify(notifications.slice(-100)));
    }

    sessionStorage.setItem("lpgPosLoggedIn", "true");
    sessionStorage.setItem("currentCompanyUser", JSON.stringify({
        username: matchedUser.username,
        role: matchedUser.role
    }));
    localStorage.removeItem("lpgPosLoggedIn");
    localStorage.removeItem("currentCompanyUser");
    window.location.href = matchedUser.role === "driver" ? "logisticrecord.html" : "dashboard.html";
}

function enforceLogin() {
    const pageName = window.location.pathname.split("/").pop().toLowerCase() || "index.htm";
    const publicPages = ["index.html", "index.htm", "logout.html"];

    if (!publicPages.includes(pageName) && !isLoggedIn()) {
        window.location.replace("index.html");
        return;
    }

    const currentUser = getCurrentUser();
    if (isLoggedIn() && currentUser?.role === "driver" && !["logisticrecord.html", "logout.html"].includes(pageName)) {
        window.location.replace("logisticrecord.html");
        return;
    }

    if (pageName === "logisticrecord.html" && isLoggedIn() && !isAdmin() && currentUser?.role !== "driver") {
        window.location.replace("dashboard.html");
        return;
    }

    if (["index.html", "index.htm"].includes(pageName) && isLoggedIn()) {
        window.location.replace(currentUser?.role === "driver" ? "logisticrecord.html" : "dashboard.html");
    }
}

function setupAutoSave() {
    const pageName = window.location.pathname.split("/").pop().toLowerCase() || "page";
    if (["index.html", "index.htm"].includes(pageName) || pageName === "logout.html") return;

    const storageKey = `lpgPosDraft:${pageName}`;
    const fields = Array.from(document.querySelectorAll("input[id], select[id], textarea[id]"))
        .filter(field => field.type !== "password" && field.type !== "search");
    let savedFields = {};
    try {
        savedFields = JSON.parse(localStorage.getItem(storageKey) || "{}");
    } catch {
        localStorage.removeItem(storageKey);
    }

    fields.forEach(field => {
        if (Object.prototype.hasOwnProperty.call(savedFields, field.id)) {
            if (field.type === "checkbox") {
                field.checked = savedFields[field.id];
            } else {
                field.value = savedFields[field.id];
            }
        }

        const saveField = () => {
            let currentFields = {};
            try {
                currentFields = JSON.parse(localStorage.getItem(storageKey) || "{}");
            } catch {
                currentFields = {};
            }
            currentFields[field.id] = field.type === "checkbox" ? field.checked : field.value;
            localStorage.setItem(storageKey, JSON.stringify(currentFields));
        };

        field.addEventListener("input", saveField);
        field.addEventListener("change", saveField);
    });
}

window.addEventListener("pagehide", () => {
    const activeElement = document.activeElement;
    if (activeElement && activeElement.matches("[contenteditable]")) {
        activeElement.blur();
    }
});

function applyRolePermissions() {
    if (isAdmin()) {
        document.body.dataset.role = "admin";
        return;
    }

    const isDriver = getCurrentUser()?.role === "driver";
    document.body.dataset.role = isDriver ? "driver" : "input";
    document.querySelectorAll(".sheet-delete, [data-admin-only], [data-input-forbidden]").forEach(control => {
        control.hidden = true;
        control.disabled = true;
    });
    if (!isDriver) {
        document.querySelectorAll("[data-driver-only]").forEach(control => {
            control.hidden = true;
            control.disabled = true;
        });
    } else {
        document.querySelectorAll(".driver-hidden").forEach(control => {
            control.hidden = true;
            control.disabled = true;
        });
    }

    document.querySelectorAll("[contenteditable]").forEach(element => {
        if (!element.closest(".empty-row")) {
            element.contentEditable = "false";
            element.setAttribute("aria-readonly", "true");
        }
    });

    document.addEventListener("click", event => {
        if (event.target.closest(".sheet-delete, [data-admin-only], [data-input-forbidden]")) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);

    document.addEventListener("focusin", event => {
        const editable = event.target.closest("[contenteditable]");
        if (editable && !editable.closest(".empty-row")) {
            editable.contentEditable = "false";
            editable.setAttribute("aria-readonly", "true");
        }
    }, true);

    document.addEventListener("beforeinput", event => {
        if (event.target.closest("[contenteditable]:not(.empty-row [contenteditable])")) {
            event.preventDefault();
        }
    }, true);
}

function canModifySavedRow(row) {
    return isAdmin() || row?.classList.contains("empty-row");
}

function addAdminCompanyColumns() {
    if (!isAdmin()) return;

    const updateTable = table => {
        const rows = Array.from(table.tBodies[0]?.rows || []);
        const companyRows = rows.filter(row => row.dataset.companyId);
        if (companyRows.length === 0) return;

        if (!table.dataset.companyColumn) {
            const header = table.tHead?.rows[0];
            if (!header) return;
            const cell = document.createElement("th");
            cell.textContent = "Company";
            cell.className = "company-column";
            header.prepend(cell);
            table.dataset.companyColumn = "true";
        }

        rows.forEach(row => {
            if (row.dataset.companyCell) return;
            const cell = document.createElement("td");
            cell.textContent = row.dataset.companyId || "";
            cell.className = "company-column";
            row.prepend(cell);
            row.dataset.companyCell = "true";
        });
    };

    const updateAllTables = () => document.querySelectorAll("table").forEach(updateTable);
    updateAllTables();
    new MutationObserver(updateAllTables).observe(document.body, { childList: true, subtree: true });
}

function renderDashboard() {
    const recentSalesBody = document.getElementById("recent-sales-body");
    if (!recentSalesBody) return;

    const stats = getDashboardStats();
    document.getElementById("product-count").textContent = String(stats.product);
    document.getElementById("customers-count").textContent = String(stats.customers);
    document.getElementById("sales-total").textContent = formatMoney(stats.totalSales);
    document.getElementById("stock-count").textContent = String(stats.totalStock);

    const companySalesBody = document.getElementById("company-sales-body");
    if (companySalesBody && isAdmin()) {
        const companyNames = [
            ...Array.from({ length: 11 }, (_, index) => `company${String(index + 1).padStart(2, "0")}`),
            "gastrade"
        ];
        const companySales = getData("sales").reduce((groups, sale) => {
            const company = sale.companyId || "Unknown";
            if (!groups[company]) groups[company] = { count: 0, total: 0 };
            groups[company].count += 1;
            groups[company].total += Number(sale.total || 0);
            return groups;
        }, {});
        const additionalCompanies = Object.keys(companySales).filter(company => !companyNames.includes(company));
        companySalesBody.innerHTML = [...companyNames, ...additionalCompanies].map(company => `
            <tr>
                <td>${escapeHTML(company)}</td>
                <td>${companySales[company]?.count || 0}</td>
                <td>${escapeHTML(formatMoney(companySales[company]?.total || 0))}</td>
            </tr>
        `).join("");
    }

    const loginNotice = document.getElementById("login-notice");
    if (loginNotice) {
        if (!isAdmin()) {
            loginNotice.hidden = true;
        } else {
            const notifications = JSON.parse(localStorage.getItem("lpgPosLoginNotifications") || "[]").slice(-10).reverse();
            loginNotice.hidden = false;
            loginNotice.innerHTML = notifications.length
                ? notifications.map(item => `<div>${escapeHTML(item.username)} logged in at ${escapeHTML(formatDateTime(item.time))}</div>`).join("")
                : "No company logins recorded yet.";
        }
    }

    const sales = getData("sales");
    const recentSales = sales.slice(-5).reverse();
    if (recentSales.length === 0) {
        recentSalesBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:30px;">No sales recorded yet.</td></tr>`;
        return;
    }

    recentSalesBody.innerHTML = recentSales.map(sale => {
        const saleIndex = sales.indexOf(sale);
        return `
            <tr data-company-id="${escapeHTML(sale.companyId || "Unknown")}">
                <td>${escapeHTML(sale.transactionId || sale.invoiceId || "-")}</td>
                <td>${escapeHTML(sale.customer || sale.description || "-")}</td>
                <td>${escapeHTML(formatMoney(sale.total || 0))}</td>
                <td>${escapeHTML(sale.payment || "-")}</td>
                <td>${escapeHTML(sale.dispatchedAt ? formatDate(sale.dispatchedAt) : "-")}</td>
                <td><button class="print-receipt" type="button" title="Print receipt" data-sale-index="${saleIndex}">Print</button></td>
            </tr>
        `;
    }).join("");

    recentSalesBody.addEventListener("click", event => {
        const printButton = event.target.closest(".print-receipt");
        if (!printButton) return;
        const sale = sales[Number(printButton.dataset.saleIndex)];
        if (sale) printReceipt(sale, "sales");
    });
}

function renderReports() {
    const tillStatsBody = document.getElementById("tillStatsBody");
    if (!tillStatsBody) return;

    const allSales = getData("sales");
    const from = document.getElementById("report-from")?.value;
    const to = document.getElementById("report-to")?.value;
    const sales = allSales.filter(sale => {
        const date = String(sale.dispatchedAt || sale.date || "").slice(0, 10);
        return (!from || date >= from) && (!to || date <= to);
    });
    const purchases = getData("purchases");
    const returns = getData("returns");
    const totalSales = sales.reduce((sum, sale) => sum + Number(sale.total || 0), 0);
    const totalPurchases = purchases.reduce((sum, purchase) => sum + Number(purchase.total || 0), 0);
    const returnedQuantity = returns.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const outstandingCredit = sales
        .filter(sale => (sale.payment || "Cash") === "Credit")
        .reduce((sum, sale) => sum + Number(sale.total || 0), 0);

    document.getElementById("reportSales").textContent = formatMoney(totalSales);
    document.getElementById("reportPurchases").textContent = formatMoney(totalPurchases);
    document.getElementById("reportReturns").textContent = `${returnedQuantity} Units`;
    document.getElementById("reportReceipts").textContent = String(sales.length);
    document.getElementById("reportCredit").textContent = formatMoney(outstandingCredit);

    const byTill = sales.reduce((groups, sale) => {
        const till = sale.till || "Unassigned";
        if (!groups[till]) groups[till] = { receipts: 0, total: 0 };
        groups[till].receipts += 1;
        groups[till].total += Number(sale.total || 0);
        return groups;
    }, {});
    const tillNames = Object.keys(byTill);

    if (tillNames.length === 0) {
        tillStatsBody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:30px;">No sales recorded yet.</td></tr>`;
    } else {
        tillStatsBody.innerHTML = tillNames.map(till => `
            <tr>
                <td>${escapeHTML(till)}</td>
                <td>${byTill[till].receipts}</td>
                <td>${escapeHTML(formatMoney(byTill[till].total))}</td>
            </tr>
        `).join("");
    }

    const renderGroup = (elementId, field) => {
        const body = document.getElementById(elementId);
        if (!body) return;
        const groups = sales.reduce((result, sale) => {
            const key = sale[field] || "Unknown";
            if (!result[key]) result[key] = { receipts: 0, total: 0 };
            result[key].receipts += 1;
            result[key].total += Number(sale.total || 0);
            return result;
        }, {});
        const names = Object.keys(groups);
        body.innerHTML = names.length ? names.map(name => `
            <tr><td>${escapeHTML(name)}</td><td>${groups[name].receipts}</td><td>${escapeHTML(formatMoney(groups[name].total))}</td></tr>
        `).join("") : `<tr><td colspan="3" style="text-align:center; padding:20px;">No sales in this period.</td></tr>`;
    };
    renderGroup("paymentStatsBody", "payment");
    renderGroup("operatorStatsBody", "operator");

    const auditLogBody = document.getElementById("auditLogBody");
    if (auditLogBody) {
        const audit = getData("audit").slice(-100).reverse();
        auditLogBody.innerHTML = audit.length ? audit.map(entry => `
            <tr>
                <td>${escapeHTML(entry.date ? formatDate(entry.date) : "-")}</td>
                <td>${escapeHTML(entry.operator || "-")}</td>
                <td>${escapeHTML(entry.action || "-")}</td>
                <td>${escapeHTML(JSON.stringify(entry.details || {}))}</td>
            </tr>
        `).join("") : `<tr><td colspan="4" style="text-align:center; padding:20px;">No audit activity yet.</td></tr>`;
    }
}

function exportAuditLog() {
    const rows = [["Date", "Operator", "Action", "Details"], ...getData("audit").map(entry => [
        entry.date || "",
        entry.operator || "",
        entry.action || "",
        JSON.stringify(entry.details || {})
    ])];
    const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = `lpg-pos-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
}


// ==========================================
// INVOICE NUMBER
// ==========================================

function generateInvoiceNumber() {

    const invoices =
        getData("invoices");


    return (
        "INV-" +
        String(
            invoices.length + 1
        ).padStart(5, "0")
    );

}


// ==========================================
// DASHBOARD STATISTICS
// ==========================================

function getDashboardStats() {

    const product =
        getData("products");

    const customers =
        getData("customers");

    const vendors =
        getData("vendors");

    const sales =
        getData("sales");

    const purchases =
        getData("purchases");


    const totalSales =
        sales.reduce(
            (total, sale) =>
                total +
                Number(
                    sale.total || 0
                ),
            0
        );


    const totalPurchases =
        purchases.reduce(
            (total, purchase) =>
                total +
                Number(
                    purchase.total || 0
                ),
            0
        );


    const totalStock =
        product.reduce(
            (total, product) =>
                total +
                Number(
                    product.stock || 0
                ),
            0
        );


    return {

        product:
            product.length,

        customers:
            customers.length,

        vendors:
            vendors.length,

        sales:
            sales.length,

        purchases:
            purchases.length,

        totalSales:
            totalSales,

        totalPurchases:
            totalPurchases,

        totalStock:
            totalStock,

        stock:
            totalStock

    };

}


// ==========================================
// CREATE STORAGE
// ==========================================

function initializeStorage() {

    const collections = [

        "products",
        "customers",
        "vendors",
        "purchases",
        "sales",
        "invoices",
        "returns",
        "inventoryMovements",
        "shifts",
        "expenses",
        "audit"

    ];


    collections.forEach(
        type => {

            const key =
                STORAGE[type];


            if (
                localStorage.getItem(key) === null
            ) {

                localStorage.setItem(
                    key,
                    "[]"
                );

            }

        }
    );


    if (
        localStorage.getItem(
            STORAGE.settings
        ) === null
    ) {

        saveSettings({

            businessName: "Gas Trade",

            businessPhone: "",

            businessEmail: "",

            businessAddress:
                "Ogun State, Nigeria",

            currency: "NGN",

            taxRate: 0,

            lowStock: 5

        });

    }

    const currentSettings = getSettings();
    if (currentSettings.businessName?.trim() === "mikel gas" || currentSettings.businessName?.trim() === "mikelgas pos") {
        currentSettings.businessName = "Gas Trade";
        localStorage.setItem(STORAGE.settings, JSON.stringify(currentSettings));
    }

}


// ==========================================
// MAKE FUNCTIONS AVAILABLE TO HTML PAGES
// ==========================================

window.POS = {

    getData,
    saveData,
    addData,
    recordAudit,
    getOpenShift,
    openTill,
    closeTill,
    recordInventoryMovement,
    updateData,
    deleteData,
    setCloudConfig,
    getCloudConfig,
    syncCloudFromRemote,
    syncCloudToRemote,

    generateId,
    formatMoney,
    formatDate,
    escapeHTML,

    getSettings,
    saveSettings,
    printReceipt,

    isLoggedIn,
    getCurrentUser,
    getCurrentRole,
    isAdmin,
    logoutUser,

    generateInvoiceNumber,
    getDashboardStats

};


// ==========================================
// START
// ==========================================

enforceLogin();
initializeStorage();
if (getCloudConfig().enabled) {
    syncCloudStateOnStartup();
}


// ==========================================
// PAGE READY
// ==========================================

document.addEventListener(
    "DOMContentLoaded",
    function () {

        console.log(
            "LPG POS JavaScript loaded successfully."
        );

        const loginForm = document.getElementById("loginForm");
        if (loginForm) {
            loginForm.addEventListener("submit", handleLogin);
        }

        const passwordToggle = document.getElementById("password-toggle");
        const passwordInput = document.getElementById("password");
        passwordToggle?.addEventListener("click", () => {
            const isHidden = passwordInput.type === "password";
            passwordInput.type = isHidden ? "text" : "password";
            passwordToggle.textContent = isHidden ? "Hide" : "Show";
            passwordToggle.setAttribute("aria-label", `${isHidden ? "Hide" : "Show"} password`);
        });

        setupAutoSave();
        applyRolePermissions();
        addAdminCompanyColumns();
        const siteClock = document.createElement("div");
        siteClock.className = "site-clock";
        siteClock.setAttribute("aria-label", "Current date and time");
        siteClock.innerHTML = '<span><strong>Date</strong><b id="site-date"></b></span><span><strong>Time</strong><b id="site-time"></b></span>';
        document.body.prepend(siteClock);
        const updateSiteClock = () => {
            const now = new Date();
            document.getElementById("site-date").textContent = formatDate(now);
            document.getElementById("site-time").textContent = now.toLocaleTimeString("en-NG", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            });
        };
        updateSiteClock();
        window.setInterval(updateSiteClock, 1000);
        const currentDate = document.getElementById("current-date");
        if (currentDate) {
            const updateDateTime = () => {
                currentDate.textContent = formatDateTime();
            };
            updateDateTime();
            window.setInterval(updateDateTime, 1000);
        }
        renderDashboard();
        renderReports();
        document.getElementById("report-from")?.addEventListener("change", renderReports);
        document.getElementById("report-to")?.addEventListener("change", renderReports);
        document.getElementById("clear-report-filter")?.addEventListener("click", () => {
            document.getElementById("report-from").value = "";
            document.getElementById("report-to").value = "";
            renderReports();
        });
        document.getElementById("export-audit")?.addEventListener("click", exportAuditLog);

        if ("serviceWorker" in navigator && ["http:", "https:"].includes(window.location.protocol)) {
            navigator.serviceWorker.register("./sw.js").catch(error => {
                console.warn("Offline cache could not be registered:", error);
            });
        }

    }
);
const tableBody = document.getElementById("productTableBody");
if (tableBody) {
    const productFields = ["waybillNumber", "truckNumber", "driverName", "driverNumber", "name", "size", "costPrice", "sellingPrice", "stock", "stockBroughtIn", "stockSold", "unit", "date"];
    const productCount = document.getElementById("productCount");
    const searchInput = document.getElementById("productSearch");

    function addEmptyProductRow() {
        const index = tableBody.querySelectorAll("tr").length;
        tableBody.insertAdjacentHTML("beforeend", `
            <tr class="empty-row" data-index="${index}">
                <td class="row-number">${index + 1}</td>
                ${productFields.map(field => `<td contenteditable="${!["stockBroughtIn", "stockSold"].includes(field) && field !== "date"}" data-field="${field}"></td>`).join("")}
                <td><span class="row-hint">Type to add</span></td>
            </tr>
        `);
    }

    function renderProducts() {
        const query = searchInput.value.trim().toLowerCase();
        const products = getData("products");
        const visibleProducts = products.filter(product => productFields.some(field => String(product[field] ?? "").toLowerCase().includes(query)));
        tableBody.innerHTML = visibleProducts.map((product, index) => `
            <tr data-index="${products.indexOf(product)}" data-company-id="${escapeHTML(product.companyId || "Unknown")}">
                <td class="row-number">${index + 1}</td>
                ${productFields.map(field => `<td contenteditable="${!["stockBroughtIn", "stockSold"].includes(field) && field !== "date"}" data-field="${field}">${escapeHTML(product[field] ?? "")}</td>`).join("")}
                <td><button class="sheet-delete" type="button" title="Delete row">Delete</button></td>
            </tr>
        `).join("");
        addEmptyProductRow();
        productCount.textContent = `${products.length} product${products.length === 1 ? "" : "s"}`;
    }

    function persistProductRow(row) {
        if (!canModifySavedRow(row)) return;
        const values = {};
        productFields.forEach(field => {
            values[field] = row.querySelector(`[data-field="${field}"]`).textContent.trim();
        });
        if (!Object.values(values).some(Boolean)) return;
        values.date = values.date || new Date().toISOString();
        values.stockBroughtIn = Number(values.stockBroughtIn || 0);
        values.stockSold = Number(values.stockSold || 0);
        const products = getData("products");
        values.id = products[Number(row.dataset.index)]?.id || generateId("PROD");
        products[Number(row.dataset.index)] = values;
        if (!saveData("products", products)) return;
        row.classList.remove("empty-row");
        if (!tableBody.lastElementChild || !tableBody.lastElementChild.classList.contains("empty-row")) {
            addEmptyProductRow();
        }
        productCount.textContent = `${products.length} product${products.length === 1 ? "" : "s"}`;
    }

    tableBody.addEventListener("focusout", event => {
        if (event.target.matches("[contenteditable]")) persistProductRow(event.target.closest("tr"));
    });

    tableBody.addEventListener("keydown", event => {
        if (event.key === "Enter" && event.target.matches("[contenteditable]")) {
            event.preventDefault();
            event.target.closest("td").nextElementSibling?.focus();
        }
    });

    tableBody.addEventListener("click", event => {
        if (!event.target.matches(".sheet-delete")) return;
        const products = getData("products");
        products.splice(Number(event.target.closest("tr").dataset.index), 1);
        saveData("products", products);
        renderProducts();
    });

    searchInput.addEventListener("input", renderProducts);
    document.getElementById("add-product-row").addEventListener("click", () => {
        tableBody.lastElementChild.querySelector("[contenteditable]").focus();
    });
    renderProducts();
}

const sellerTableBody = document.getElementById("sellerTableBody");
if (sellerTableBody) {
    const sellerFields = ["operatorId", "name", "phone", "role", "shift", "status", "date"];
    const sellerStorageKey = STORAGE.sellers;
    const statusElement = document.getElementById("seller-sheet-status");

    function readSellers() {
        return getData("sellers");
    }

    function saveSellers(sellers) {
        if (saveData("sellers", sellers)) statusElement.textContent = "All changes saved";
    }

    function addEmptySellerRow() {
        const index = sellerTableBody.querySelectorAll("tr").length;
        sellerTableBody.insertAdjacentHTML("beforeend", `
            <tr class="empty-row" data-index="${index}">
                <td class="row-number">${index + 1}</td>
                ${sellerFields.map(field => `<td contenteditable="${field !== "date"}" data-field="${field}"></td>`).join("")}
                <td><span class="row-hint">Type to add</span></td>
            </tr>
        `);
    }

    function renderSellerSheet() {
        const sellers = readSellers();
        sellerTableBody.innerHTML = sellers.map((seller, index) => `
            <tr data-index="${index}" data-company-id="${escapeHTML(seller.companyId || "Unknown")}">
                <td class="row-number">${index + 1}</td>
                ${sellerFields.map(field => `<td contenteditable="${field !== "date"}" data-field="${field}">${field === "date" ? escapeHTML(seller[field] ? formatDate(seller[field]) : "") : escapeHTML(seller[field])}</td>`).join("")}
                <td><button class="sheet-delete" type="button" title="Delete row">Delete</button></td>
            </tr>
        `).join("");
        addEmptySellerRow();
    }

    function persistRow(row) {
        if (!canModifySavedRow(row)) return;
        const values = {};
        sellerFields.forEach(field => {
            values[field] = row.querySelector(`[data-field="${field}"]`).textContent.trim();
        });
        if (!Object.values(values).some(Boolean)) return;
        values.date = values.date || new Date().toISOString();
        values.id = values.id || generateId("SELL");
        const sellers = readSellers();
        sellers[Number(row.dataset.index)] = values;
        saveSellers(sellers);
        row.classList.remove("empty-row");
        if (!sellerTableBody.lastElementChild.classList.contains("empty-row")) addEmptySellerRow();
    }

    sellerTableBody.addEventListener("focusout", event => {
        if (event.target.matches("[contenteditable]")) persistRow(event.target.closest("tr"));
    });

    sellerTableBody.addEventListener("keydown", event => {
        if (event.key === "Enter" && event.target.matches("[contenteditable]")) {
            event.preventDefault();
            event.target.closest("td").nextElementSibling?.focus();
        }
    });

    sellerTableBody.addEventListener("click", event => {
        if (!event.target.matches(".sheet-delete")) return;
        const sellers = readSellers();
        sellers.splice(Number(event.target.closest("tr").dataset.index), 1);
        saveSellers(sellers);
        renderSellerSheet();
    });

    document.getElementById("add-seller-row").addEventListener("click", () => {
        sellerTableBody.lastElementChild.querySelector("[contenteditable]").focus();
    });

    document.getElementById("header-add-seller").addEventListener("click", () => {
        sellerTableBody.lastElementChild.querySelector("[contenteditable]").focus();
    });

    renderSellerSheet();
}

const salesTableBody = document.getElementById("salesTableBody");
if (salesTableBody) {
    const saleFields = ["transactionId", "description", "quantity", "subtotal", "discount", "tax", "total", "customer", "till", "operator", "payment", "dispatchedAt"];
    const statusElement = document.getElementById("sales-sheet-status");

    function addEmptySaleRow() {
        const index = salesTableBody.querySelectorAll("tr").length;
        salesTableBody.insertAdjacentHTML("beforeend", `
            <tr class="empty-row" data-index="${index}">
                <td class="row-number">${index + 1}</td>
                ${saleFields.map(field => `<td contenteditable="true" data-field="${field}"></td>`).join("")}
                <td><span class="row-hint">Type to add</span></td>
            </tr>
        `);
    }

    function renderSalesSheet() {
        const sales = getData("sales");
        salesTableBody.innerHTML = sales.map((sale, index) => `
            <tr data-index="${index}" data-company-id="${escapeHTML(sale.companyId || "Unknown")}">
                <td class="row-number">${index + 1}</td>
                ${saleFields.map(field => `<td contenteditable="true" data-field="${field}">${field === "dispatchedAt" ? escapeHTML(sale[field] ? formatDate(sale[field]) : "") : escapeHTML(sale[field])}</td>`).join("")}
                <td>
                    <button class="print-receipt" type="button" title="Print receipt">Print</button>
                    <button class="sheet-delete" type="button" title="Delete row">Delete</button>
                </td>
            </tr>
        `).join("");
        addEmptySaleRow();
    }

    let checkoutPrintRequested = false;

    const updateCheckoutTotal = () => {
        const quantity = Number(document.getElementById("checkout-quantity")?.value || 0);
        const unitPrice = Number(document.getElementById("checkout-unit-price")?.value || 0);
        const subtotal = quantity * unitPrice;
        const totalField = document.getElementById("checkout-total");
        if (totalField) totalField.value = subtotal.toFixed(2);
        return subtotal;
    };

    document.getElementById("checkout-quantity")?.addEventListener("input", updateCheckoutTotal);
    document.getElementById("checkout-unit-price")?.addEventListener("input", updateCheckoutTotal);

    document.getElementById("checkout-form")?.addEventListener("submit", event => {
        event.preventDefault();
        const description = document.getElementById("checkout-description").value.trim();
        const quantity = document.getElementById("checkout-quantity").value;
        const subtotal = updateCheckoutTotal();
        const discount = Number(document.getElementById("checkout-discount").value || 0);
        const taxRate = Number(document.getElementById("checkout-tax").value || 0);
        const taxable = Math.max(0, subtotal - discount);
        const tax = taxable * taxRate / 100;
        const total = taxable + tax;
        const till = document.getElementById("checkout-till").value.trim() || "Till 1";
        const payment = document.getElementById("checkout-payment").value;
        const openShift = getOpenShift(till);
        if (!openShift) {
            document.getElementById("checkout-status").textContent = `Open ${till} in Till Shift before selling`;
            checkoutPrintRequested = false;
            return;
        }
        const sales = getData("sales");
        const sale = {
            id: generateId("SALE"),
            transactionId: generateInvoiceNumber(),
            description,
            quantity,
            subtotal,
            discount,
            tax,
            total,
            customer: document.getElementById("checkout-customer").value.trim() || "Walk-in customer",
            till,
            operator: getCurrentUser()?.username || "Unknown",
            payment,
            dispatchedAt: new Date().toISOString()
        };
        sales.push(sale);
        if (!saveData("sales", sales)) return;
        recordInventoryMovement(description, -Number(quantity || 0), "sale", sale.transactionId);
        recordAudit("sale_completed", sale);
        event.target.reset();
        document.getElementById("checkout-quantity").value = "1";
        document.getElementById("checkout-unit-price").value = "0";
        document.getElementById("checkout-discount").value = "0";
        document.getElementById("checkout-tax").value = "0";
        document.getElementById("checkout-total").value = "0.00";
        document.getElementById("checkout-till").value = till;
        document.getElementById("checkout-status").textContent = "Sale saved";
        renderSalesSheet();
        renderDashboard();
        renderReports();
        const shouldPrint = event.submitter?.dataset.printReceipt === "true" || checkoutPrintRequested;
        if (shouldPrint) {
            printReceipt(sale, "sales");
            checkoutPrintRequested = false;
        }
    });

    document.querySelector("[data-print-receipt='true']")?.addEventListener("click", () => {
        checkoutPrintRequested = true;
    });

    updateCheckoutTotal();

    const shiftForm = document.getElementById("till-form");
    const shiftTill = document.getElementById("shift-till");
    const tillStatus = document.getElementById("till-status");
    const refreshTillStatus = () => {
        const shift = getOpenShift(shiftTill.value.trim());
        tillStatus.textContent = shift ? `Open since ${formatDate(shift.openedAt)} with ${formatMoney(shift.openingCash)}` : "No open till";
    };
    shiftForm?.addEventListener("submit", event => {
        event.preventDefault();
        const shift = openTill(
            shiftTill.value.trim(),
            document.getElementById("opening-cash").value,
            document.getElementById("opening-kg").value
        );
        tillStatus.textContent = shift ? "Till opened" : "This till is already open";
        refreshTillStatus();
    });
    document.getElementById("close-till")?.addEventListener("click", () => {
        const shift = closeTill(
            shiftTill.value.trim(),
            document.getElementById("closing-cash").value,
            document.getElementById("closing-kg").value
        );
        tillStatus.textContent = shift
            ? `Till closed. Cash variance: ${formatMoney(shift.variance)}. KG variance: ${shift.kgVariance.toFixed(2)} KG`
            : "No open till to close";
    });
    shiftTill?.addEventListener("input", refreshTillStatus);
    refreshTillStatus();

    function persistSaleRow(row) {
        if (!canModifySavedRow(row)) return;
        const isNewSale = row.classList.contains("empty-row");
        const values = {};
        saleFields.forEach(field => {
            values[field] = row.querySelector(`[data-field="${field}"]`).textContent.trim();
        });
        if (!Object.values(values).some(Boolean)) return;
        values.till = values.till || "Till 1";
        values.operator = values.operator || (getCurrentUser()?.username || "Unknown");
        values.payment = values.payment || "Cash";
        values.dispatchedAt = values.dispatchedAt || new Date().toISOString();
        values.id = values.id || generateId("SALE");
        const sales = getData("sales");
        sales[Number(row.dataset.index)] = values;
        saveData("sales", sales);
        if (isNewSale) {
            recordInventoryMovement(values.description, -Number(values.quantity || 0), "sale", values.transactionId || values.id);
            recordAudit("sale_completed", values);
        }
        statusElement.textContent = "All changes saved";
        row.classList.remove("empty-row");
        if (!salesTableBody.lastElementChild.classList.contains("empty-row")) addEmptySaleRow();
    }

    salesTableBody.addEventListener("focusout", event => {
        if (event.target.matches("[contenteditable]")) persistSaleRow(event.target.closest("tr"));
    });

    salesTableBody.addEventListener("keydown", event => {
        if (event.key === "Enter" && event.target.matches("[contenteditable]")) {
            event.preventDefault();
            event.target.closest("td").nextElementSibling?.focus();
        }
    });

    salesTableBody.addEventListener("click", event => {
        const printButton = event.target.closest(".print-receipt");
        if (printButton) {
            const sale = getData("sales")[Number(printButton.closest("tr").dataset.index)];
            if (sale) printReceipt(sale, "sales");
            return;
        }
        if (!event.target.matches(".sheet-delete")) return;
        const sales = getData("sales");
        sales.splice(Number(event.target.closest("tr").dataset.index), 1);
        saveData("sales", sales);
        renderSalesSheet();
    });

    const focusNewSaleRow = () => salesTableBody.lastElementChild.querySelector("[contenteditable]").focus();
    document.getElementById("add-sale-row").addEventListener("click", focusNewSaleRow);
    document.getElementById("header-add-sale").addEventListener("click", focusNewSaleRow);
    renderSalesSheet();
}

const returnTableBody = document.getElementById("returnTableBody");
if (returnTableBody) {
    const returnFields = ["returnId", "invoiceRef", "description", "quantity", "processedAt"];
    const statusElement = document.getElementById("returns-sheet-status");

    function addEmptyReturnRow() {
        const index = returnTableBody.querySelectorAll("tr").length;
        returnTableBody.insertAdjacentHTML("beforeend", `
            <tr class="empty-row" data-index="${index}">
                <td class="row-number">${index + 1}</td>
                ${returnFields.map(field => `<td contenteditable="true" data-field="${field}"></td>`).join("")}
                <td><span class="row-hint">Type to add</span></td>
            </tr>
        `);
    }

    function renderReturnsSheet() {
        const returns = getData("returns");
        returnTableBody.innerHTML = returns.map((item, index) => `
            <tr data-index="${index}" data-company-id="${escapeHTML(item.companyId || "Unknown")}">
                <td class="row-number">${index + 1}</td>
                ${returnFields.map(field => `<td contenteditable="true" data-field="${field}">${escapeHTML(item[field])}</td>`).join("")}
                <td><button class="sheet-delete" type="button" title="Delete row">Delete</button></td>
            </tr>
        `).join("");
        addEmptyReturnRow();
    }

    function persistReturnRow(row) {
        if (!canModifySavedRow(row)) return;
        const isNewReturn = row.classList.contains("empty-row");
        const values = {};
        returnFields.forEach(field => {
            values[field] = row.querySelector(`[data-field="${field}"]`).textContent.trim();
        });
        if (!Object.values(values).some(Boolean)) return;
        values.processedAt = values.processedAt || new Date().toISOString();
        values.id = values.id || generateId("RET");
        const returns = getData("returns");
        returns[Number(row.dataset.index)] = values;
        saveData("returns", returns);
        if (isNewReturn) {
            recordInventoryMovement(values.description, Number(values.quantity || 0), "return", values.returnId || values.id);
            recordAudit("return_recorded", values);
        }
        statusElement.textContent = "All changes saved";
        row.classList.remove("empty-row");
        if (!returnTableBody.lastElementChild.classList.contains("empty-row")) addEmptyReturnRow();
    }

    returnTableBody.addEventListener("focusout", event => {
        if (event.target.matches("[contenteditable]")) persistReturnRow(event.target.closest("tr"));
    });

    returnTableBody.addEventListener("keydown", event => {
        if (event.key === "Enter" && event.target.matches("[contenteditable]")) {
            event.preventDefault();
            event.target.closest("td").nextElementSibling?.focus();
        }
    });

    returnTableBody.addEventListener("click", event => {
        if (!event.target.matches(".sheet-delete")) return;
        const returns = getData("returns");
        returns.splice(Number(event.target.closest("tr").dataset.index), 1);
        saveData("returns", returns);
        renderReturnsSheet();
    });

    const focusNewReturnRow = () => returnTableBody.lastElementChild.querySelector("[contenteditable]").focus();
    document.getElementById("add-return-row").addEventListener("click", focusNewReturnRow);
    document.getElementById("header-add-return").addEventListener("click", focusNewReturnRow);
    renderReturnsSheet();
}

const reportsTable = document.getElementById("reportsTable");
if (reportsTable) {
    const reportsStatus = document.getElementById("reports-sheet-status");

    document.getElementById("add-report-row").addEventListener("click", () => {
        const row = reportsTable.tBodies[0].insertRow();
        for (let column = 0; column < reportsTable.tHead.rows[0].cells.length; column += 1) {
            const cell = row.insertCell();
            cell.contentEditable = "true";
            cell.textContent = "";
        }
        row.cells[0].focus();
        reportsStatus.textContent = "New row added";
    });

    document.getElementById("add-report-column").addEventListener("click", () => {
        const header = reportsTable.tHead.rows[0].insertCell();
        header.outerHTML = "<th contenteditable=\"true\">New column</th>";
        Array.from(reportsTable.tBodies[0].rows).forEach(row => {
            const cell = row.insertCell();
            cell.contentEditable = "true";
        });
        reportsStatus.textContent = "New column added";
    });
}

const purchaseTableBody = document.getElementById("purchaseTableBody");
if (purchaseTableBody) {
    const purchaseFields = ["orderId", "vendor", "item", "quantity", "total", "date"];
    const statusElement = document.getElementById("purchases-sheet-status");

    function addEmptyPurchaseRow() {
        const index = purchaseTableBody.querySelectorAll("tr").length;
        purchaseTableBody.insertAdjacentHTML("beforeend", `
            <tr class="empty-row" data-index="${index}">
                <td class="row-number">${index + 1}</td>
                ${purchaseFields.map(field => `<td contenteditable="true" data-field="${field}"></td>`).join("")}
                <td><span class="row-hint">Type to add</span></td>
            </tr>
        `);
    }

    function renderPurchaseSheet() {
        const purchases = getData("purchases");
        purchaseTableBody.innerHTML = purchases.map((purchase, index) => `
            <tr data-index="${index}" data-company-id="${escapeHTML(purchase.companyId || "Unknown")}">
                <td class="row-number">${index + 1}</td>
                ${purchaseFields.map(field => `<td contenteditable="true" data-field="${field}">${escapeHTML(purchase[field])}</td>`).join("")}
                <td><button class="sheet-delete" type="button" title="Delete row">Delete</button></td>
            </tr>
        `).join("");
        addEmptyPurchaseRow();
    }

    function persistPurchaseRow(row) {
        if (!canModifySavedRow(row)) return;
        const isNewPurchase = row.classList.contains("empty-row");
        const values = {};
        purchaseFields.forEach(field => {
            values[field] = row.querySelector(`[data-field="${field}"]`).textContent.trim();
        });
        if (!Object.values(values).some(Boolean)) return;
        values.date = values.date || new Date().toISOString();
        values.id = values.id || generateId("PUR");
        const purchases = getData("purchases");
        purchases[Number(row.dataset.index)] = values;
        saveData("purchases", purchases);
        if (isNewPurchase) {
            recordInventoryMovement(values.item, Number(values.quantity || 0), "purchase", values.orderId || values.id);
            recordAudit("purchase_recorded", values);
        }
        statusElement.textContent = "All changes saved";
        row.classList.remove("empty-row");
        if (!purchaseTableBody.lastElementChild.classList.contains("empty-row")) addEmptyPurchaseRow();
    }

    purchaseTableBody.addEventListener("focusout", event => {
        if (event.target.matches("[contenteditable]")) persistPurchaseRow(event.target.closest("tr"));
    });

    purchaseTableBody.addEventListener("keydown", event => {
        if (event.key === "Enter" && event.target.matches("[contenteditable]")) {
            event.preventDefault();
            event.target.closest("td").nextElementSibling?.focus();
        }
    });

    purchaseTableBody.addEventListener("click", event => {
        if (!event.target.matches(".sheet-delete")) return;
        const purchases = getData("purchases");
        purchases.splice(Number(event.target.closest("tr").dataset.index), 1);
        saveData("purchases", purchases);
        renderPurchaseSheet();
    });

    const focusNewPurchaseRow = () => purchaseTableBody.lastElementChild.querySelector("[contenteditable]").focus();
    document.getElementById("add-purchase-row").addEventListener("click", focusNewPurchaseRow);
    document.getElementById("header-add-purchase").addEventListener("click", focusNewPurchaseRow);
    renderPurchaseSheet();
}

const invoiceTableBody = document.getElementById("invoiceTableBody");
if (invoiceTableBody) {
    const invoiceFields = ["invoiceId", "customer", "total", "payment", "date"];
    const statusElement = document.getElementById("invoices-sheet-status");

    function addEmptyInvoiceRow() {
        const index = invoiceTableBody.querySelectorAll("tr").length;
        invoiceTableBody.insertAdjacentHTML("beforeend", `
            <tr class="empty-row" data-index="${index}">
                <td class="row-number">${index + 1}</td>
                ${invoiceFields.map(field => `<td contenteditable="true" data-field="${field}"></td>`).join("")}
                <td><span class="row-hint">Type to add</span></td>
            </tr>
        `);
    }

    function renderInvoiceSheet() {
        const invoices = getData("invoices");
        invoiceTableBody.innerHTML = invoices.map((invoice, index) => `
            <tr data-index="${index}" data-company-id="${escapeHTML(invoice.companyId || "Unknown")}">
                <td class="row-number">${index + 1}</td>
                ${invoiceFields.map(field => `<td contenteditable="true" data-field="${field}">${escapeHTML(invoice[field])}</td>`).join("")}
                <td>
                    <button class="print-receipt" type="button" title="Print receipt">Print</button>
                    <button class="sheet-delete" type="button" title="Delete row">Delete</button>
                </td>
            </tr>
        `).join("");
        addEmptyInvoiceRow();
    }

    function persistInvoiceRow(row) {
        if (!canModifySavedRow(row)) return;
        const values = {};
        invoiceFields.forEach(field => {
            values[field] = row.querySelector(`[data-field="${field}"]`).textContent.trim();
        });
        if (!Object.values(values).some(Boolean)) return;
        values.payment = values.payment || "Cash";
        const invoices = getData("invoices");
        values.id = generateId("INV");
        invoices[Number(row.dataset.index)] = values;
        saveData("invoices", invoices);
        statusElement.textContent = "All changes saved";
        row.classList.remove("empty-row");
        if (!invoiceTableBody.lastElementChild.classList.contains("empty-row")) addEmptyInvoiceRow();
    }

    invoiceTableBody.addEventListener("focusout", event => {
        if (event.target.matches("[contenteditable]")) persistInvoiceRow(event.target.closest("tr"));
    });

    invoiceTableBody.addEventListener("keydown", event => {
        if (event.key === "Enter" && event.target.matches("[contenteditable]")) {
            event.preventDefault();
            event.target.closest("td").nextElementSibling?.focus();
        }
    });

    invoiceTableBody.addEventListener("click", event => {
        const printButton = event.target.closest(".print-receipt");
        if (printButton) {
            const invoice = getData("invoices")[Number(printButton.closest("tr").dataset.index)];
            if (invoice) printReceipt(invoice, "invoices");
            return;
        }
        if (!event.target.matches(".sheet-delete")) return;
        const invoices = getData("invoices");
        invoices.splice(Number(event.target.closest("tr").dataset.index), 1);
        saveData("invoices", invoices);
        renderInvoiceSheet();
    });

    const focusNewInvoiceRow = () => invoiceTableBody.lastElementChild.querySelector("[contenteditable]").focus();
    document.getElementById("add-invoice-row").addEventListener("click", focusNewInvoiceRow);
    document.getElementById("header-add-invoice").addEventListener("click", focusNewInvoiceRow);
    renderInvoiceSheet();
}

const customerTableBody = document.getElementById("customerTableBody");
if (customerTableBody) {
    const customerFields = ["name", "phone", "email", "address", "date"];
    const customerCount = document.getElementById("customerCount");
    const searchInput = document.getElementById("customerSearch");

    function addEmptyCustomerRow() {
        const index = customerTableBody.querySelectorAll("tr").length;
        customerTableBody.insertAdjacentHTML("beforeend", `
            <tr class="empty-row" data-index="${index}">
                <td class="row-number">${index + 1}</td>
                ${customerFields.map(field => `<td contenteditable="${field !== "date"}" data-field="${field}"></td>`).join("")}
                <td><span class="row-hint">Type to add</span></td>
            </tr>
        `);
    }

    function renderCustomers() {
        const query = searchInput.value.trim().toLowerCase();
        const customers = getData("customers");
        const visibleCustomers = customers.filter(customer => customerFields.some(field => String(customer[field] ?? "").toLowerCase().includes(query)));
        customerTableBody.innerHTML = visibleCustomers.map((customer, index) => `
            <tr data-index="${customers.indexOf(customer)}" data-company-id="${escapeHTML(customer.companyId || "Unknown")}">
                <td class="row-number">${index + 1}</td>
                ${customerFields.map(field => `<td contenteditable="${field !== "date"}" data-field="${field}">${field === "date" ? escapeHTML(customer[field] ? formatDate(customer[field]) : "") : escapeHTML(customer[field])}</td>`).join("")}
                <td><button class="sheet-delete" type="button" title="Delete row">Delete</button></td>
            </tr>
        `).join("");
        addEmptyCustomerRow();
        customerCount.textContent = `${customers.length} Customer${customers.length === 1 ? "" : "s"}`;
    }

    function persistCustomerRow(row) {
        if (!canModifySavedRow(row)) return;
        const values = {};
        customerFields.forEach(field => {
            values[field] = row.querySelector(`[data-field="${field}"]`).textContent.trim();
        });
        if (!Object.values(values).some(Boolean)) return;
        values.date = values.date || new Date().toISOString();
        const customers = getData("customers");
        values.id = generateId("CUS");
        customers[Number(row.dataset.index)] = values;
        saveData("customers", customers);
        row.classList.remove("empty-row");
        renderCustomers();
    }

    customerTableBody.addEventListener("focusout", event => {
        if (event.target.matches("[contenteditable]")) persistCustomerRow(event.target.closest("tr"));
    });

    customerTableBody.addEventListener("keydown", event => {
        if (event.key === "Enter" && event.target.matches("[contenteditable]")) {
            event.preventDefault();
            event.target.closest("td").nextElementSibling?.focus();
        }
    });

    customerTableBody.addEventListener("click", event => {
        if (!event.target.matches(".sheet-delete")) return;
        const customers = getData("customers");
        customers.splice(Number(event.target.closest("tr").dataset.index), 1);
        saveData("customers", customers);
        renderCustomers();
    });

    const focusNewCustomerRow = () => customerTableBody.lastElementChild.querySelector("[contenteditable]").focus();
    searchInput.addEventListener("input", renderCustomers);
    document.getElementById("add-customer-row").addEventListener("click", focusNewCustomerRow);
    document.getElementById("generateCustomerBtn").addEventListener("click", focusNewCustomerRow);
    renderCustomers();
}
