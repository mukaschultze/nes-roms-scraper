import cliProgress from "cli-progress";
import fs from "fs/promises";
import fetch, { RequestInfo, RequestInit } from "node-fetch";
import { parse as parseHtml } from "node-html-parser";
import path from "path";
import {
  catchError,
  concat,
  concatMap,
  defer,
  EMPTY,
  firstValueFrom,
  from,
  map,
  mergeMap,
  MonoTypeOperatorFunction,
  Observable,
  of,
  range,
  retry,
  switchMap,
  tap,
  timeout,
  toArray,
} from "rxjs";
import { Extras, ROM } from "./rom";

const distinctArray = <T extends string | number>(arr: Array<T>) => [...new Set(arr)];

const BASE_URL = "https://www.consoleroms.com";
const CONCURRENT_REQUESTS = 50;

const fetch$ = (url: RequestInfo, init?: RequestInit) =>
  defer(() => fetch(typeof url === "string" && !url.startsWith("http") ? `${BASE_URL}${url}` : url, init)).pipe(
    timeout(10000),
    retry(15),
    tap({ error: (err) => console.error("Failed to download", url, err) }),
    catchError(() => EMPTY)
  );

const progress =
  <T>(total: number, label: (value: T) => string): MonoTypeOperatorFunction<T> =>
  (source: Observable<T>) => {
    const bar = new cliProgress.SingleBar(
      { format: `{bar} {percentage}% | {value} of {total} | {label}` },
      cliProgress.Presets.shades_grey
    );
    return source.pipe(
      tap({
        subscribe: () => bar.start(total, 0, { label: "Processing..." }),
        next: (value) => bar.increment({ label: label(value) }),
        complete: () => bar.stop(),
      })
    );
  };

const fetchPage = (url: string) => {
  const fileName = path.join("./output/tmp", url.replace(/\//gi, "_") + ".html");
  return of(null).pipe(
    switchMap(() =>
      defer(() => fs.stat(fileName)).pipe(
        map((a) => a.isFile() && a.size > 0),
        catchError(() => of(false))
      )
    ),
    switchMap((exists) =>
      exists
        ? fs.readFile(fileName, "utf8")
        : fetch$(url).pipe(
            switchMap((req) => req.text()),
            tap((hmtl) => fs.writeFile(fileName, hmtl))
          )
    ),
    map((html) => parseHtml(html))
  );
};

await fs.mkdir("./output/tmp", { recursive: true });
await fs.mkdir("./output/thumbs", { recursive: true });
await fs.mkdir("./output/roms", { recursive: true });

// const emulators = fetchPage("/roms").pipe(
//   mergeMap((page) => page.querySelectorAll(".infoBox a").map((a) => a.attributes.href)),
//   map((href) => href?.split("/").pop() ?? "")
// );

const emulators = from(["nes"]);

const pageCount = (emulator: string) =>
  fetchPage(`/roms/${emulator}`).pipe(
    map((page) => page.querySelector("li.page-item:last-child a")?.attributes.href),
    map((href) => +(href?.split("/").pop() || 1))
  );

const pages = await firstValueFrom(
  emulators.pipe(
    mergeMap((emulator) => pageCount(emulator).pipe(map((pageCount) => [emulator, pageCount] as const))),
    concatMap(([emulator, pageCount]) =>
      range(1, pageCount).pipe(
        mergeMap((page) => fetchPage(`/roms/${emulator}/page/${page}`), CONCURRENT_REQUESTS),
        progress(pageCount, () => `Downloading pages for ${emulator}`)
      )
    ),
    toArray()
  )
);

const tiles = pages
  .map((dom) => dom.querySelectorAll(".thumbnail-home"))
  .map((tiles) => new Array(tiles.length).fill(undefined).map((_, i) => tiles[i]))
  .flatMap((tiles) => tiles);

const romsTiles = tiles.map((tile) => {
  // Title
  const infoBox = tile.querySelector(".infoBox");
  const anchor = infoBox?.querySelector("a");
  const id = anchor?.attributes.href?.split("/").pop();
  const href = anchor?.attributes.href ?? "";
  const title = anchor?.innerText;

  // Thumbs
  const imgCon = tile.querySelector(".imgCon");
  const thumbnailElement = imgCon?.querySelector("img");
  const thumbnailsAttr = ["src", "srcset", "data-src", "data-srcset"];
  const thumbnail = thumbnailsAttr.map((attr) => thumbnailElement?.attributes[attr]).find((a) => !!a);

  const emulator = tile.querySelector(".emulator")?.innerText ?? "";

  // Tags
  const tags = tile
    .querySelectorAll("[rel='tag']")
    .map((tr) => ({ id: tr.attributes.href.split("/").pop(), label: tr.innerText.trim() }));

  return { id, title, href, emulator, tags, thumbnail };
});

const romExtraData = (rom: typeof romsTiles[number]) =>
  fetchPage(rom.href).pipe(
    map(
      (page) =>
        Object.fromEntries(
          page
            .querySelectorAll("[itemprop]")
            .map((tr) => [tr.attributes.itemprop, tr.attributes.href || tr.attributes.src || tr.innerText.trim()])
        ) as unknown as Extras
    )
  );

const roms = await firstValueFrom(
  from(romsTiles).pipe(
    mergeMap((rom) => romExtraData(rom).pipe(map((extras) => ({ ...rom, extras } as ROM))), CONCURRENT_REQUESTS),
    progress(romsTiles.length, (rom) => `Downloading ROM metadata: ${rom.title}`),
    toArray()
  )
);

await fs.writeFile("./output/roms.json", JSON.stringify(roms, null, 2));

const downloadFile = (url: string, output: string) => {
  const fileName = path.join(output, url.split("/").pop()!);
  return of(null).pipe(
    switchMap(() =>
      defer(() => fs.stat(fileName)).pipe(
        map((a) => a.isFile() && a.size > 0),
        catchError(() => of(false))
      )
    ),
    switchMap((exists) =>
      exists
        ? of(undefined)
        : fetch$(url).pipe(
            switchMap((req) => req.arrayBuffer()),
            map((buf) => new Uint8Array(buf)),
            switchMap(async (data) => {
              await fs.writeFile(fileName, data);
            })
          )
    ),
    map(() => url)
  );
};

const downloadMany = (urls: Array<string>, output: string) =>
  defer(() => fs.mkdir(output, { recursive: true })).pipe(
    switchMap(() => from(urls)),
    mergeMap((url) => downloadFile(url, output), CONCURRENT_REQUESTS),
    progress(urls.length, (url) => `Downloading file: '${url}'`),
    toArray()
  );

const thumbsUrls = distinctArray(roms.map((rom) => rom.thumbnail).filter((url) => url));
const imageUrls = distinctArray(roms.map((rom) => rom.extras.image).filter((url) => url));

const downloadUrls = distinctArray(roms.flatMap((rom) => rom.extras.downloadUrl));
const romsUrl = from(downloadUrls).pipe(
  mergeMap((url) => fetchPage(url), CONCURRENT_REQUESTS),
  map((dom) => dom.querySelector("a[rel='nofollow']")?.attributes.href ?? ""),
  progress(downloadUrls.length, () => `Fetching ROMs download URLs`),
  toArray(),
  map((urls) => distinctArray(urls.filter((url) => url)))
);

concat(
  downloadMany(thumbsUrls, "./output/thumbs"),
  downloadMany(imageUrls, "./output/images"),
  romsUrl.pipe(switchMap((romsUrl) => downloadMany(romsUrl, "./output/roms")))
).subscribe();
