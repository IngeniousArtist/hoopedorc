import { expect, type Page, type TestInfo } from "@playwright/test";

export const TARGET_VIEWPORTS = [
  { name: "phone-360", width: 360, height: 800 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "tablet-768", width: 768, height: 900 },
  { name: "desktop-1280", width: 1280, height: 800 },
  { name: "desktop-1440", width: 1440, height: 900 },
] as const;

export async function overflowDetails(page: Page) {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => !element.closest("[data-horizontal-scroll]"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          text: element.innerText.slice(0, 60),
          left: rect.left,
          right: rect.right,
        };
      })
      .filter(({ left, right }) => left < -1 || right > viewportWidth + 1)
      .slice(0, 10);
    return {
      viewportWidth,
      documentWidth: document.documentElement.scrollWidth,
      offenders,
    };
  });
}

export async function expectNoDocumentOverflow(page: Page) {
  const details = await overflowDetails(page);
  expect(details.documentWidth, JSON.stringify(details, null, 2)).toBeLessThanOrEqual(
    details.viewportWidth + 1,
  );
  expect(details.offenders, JSON.stringify(details, null, 2)).toEqual([]);
}

export async function expectFixedSurfacesInsideViewport(page: Page) {
  const clipped = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    return [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        const position = getComputedStyle(element).position;
        return position === "fixed" || position === "sticky";
      })
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          text: element.innerText.slice(0, 60),
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
        };
      })
      .filter(
        ({ top, left, right, bottom }) =>
          top < -1 || left < -1 || right > width + 1 || bottom > height + 1,
      );
  });
  expect(clipped, JSON.stringify(clipped, null, 2)).toEqual([]);
}

export async function expectPhoneTouchTargets(page: Page) {
  const undersized = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, select, summary")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          text: element.innerText.slice(0, 60) || element.getAttribute("aria-label"),
          height: rect.height,
        };
      })
      .filter(({ height }) => height < 39.5),
  );
  expect(undersized, JSON.stringify(undersized, null, 2)).toEqual([]);
}

export async function captureViewport(
  page: Page,
  testInfo: TestInfo,
  name: string,
) {
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    animations: "disabled",
  });
}

