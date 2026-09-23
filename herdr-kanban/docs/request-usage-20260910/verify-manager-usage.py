from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).parent
BASE = "http://127.0.0.1:7777/"

def open_tasks(page, url):
    page.goto(url)
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_selector("#burger")
    page.locator("#burger").click()
    page.locator('[data-view="tasks"]').click()
    page.wait_for_selector(".manager-tasks-table")

def check(page, name):
    headers = [h.inner_text() for h in page.locator(".manager-tasks-table th").all()]
    assert any("Usage" in h for h in headers), headers
    page.locator('button[aria-label^="Sort by Usage"]').click()
    assert page.locator(".task-usage").count() > 0
    overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
    assert not overflow
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    desktop = browser.new_page(viewport={"width": 1440, "height": 900})
    open_tasks(desktop, BASE + "?project=Injectbuddy")
    check(desktop, "live-desktop")
    desktop.close()

    mobile = browser.new_page(viewport={"width": 390, "height": 844})
    open_tasks(mobile, BASE + "?project=Injectbuddy")
    check(mobile, "live-mobile")
    mobile.close()

    mock = browser.new_page(viewport={"width": 390, "height": 844})
    open_tasks(mock, BASE + "?mock")
    mock.locator("tr[data-request-id='REQ-20260910-016']").click()
    mock.wait_for_selector(".task-usage-detail")
    assert "uncached" in mock.locator(".task-usage-detail").inner_text()
    mock.screenshot(path=str(OUT / "mock-expanded-mobile.png"), full_page=True)
    mock.close()
    browser.close()

print({"ok": True, "screenshots": ["live-desktop.png", "live-mobile.png", "mock-expanded-mobile.png"]})
