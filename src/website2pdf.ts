#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any*/
import {PromisePool} from '@supercharge/promise-pool';
import * as fs from 'fs-extra';
import {red} from 'kleur';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import 'reflect-metadata';
import {URL} from 'url';
import {ICliArguments} from './cli/iArgumentsParser';
import {Website2PdfCli} from './cli/website2pdfCli';
import {PdfTemplate} from './model/pdfTemplate';
import {Website} from './model/website';
import {WebsiteSitemap} from './model/websiteSitemap';
import {
  headerFactory,
  interpolate,
  puppeteerBrowserLaunchArgs,
  toFilename,
  toFilePath,
} from './utils/helpers';
import {logger} from './utils/logger';
import {PrintResults, STATUS_ERROR, STATUS_PRINTED} from './utils/stats';

export class Website2Pdf {
  static async main(): Promise<void> {
    return new Website2PdfCli().parse().then(async cliArgs => {
      headerFactory();
      const website = new Website(cliArgs);
      await website.build().then(async (website: Website) => {
        if (website.sitemaps.length !== 0) {
          await processSitemaps(cliArgs, website);
        } else {
          logger().warn(
            `No sitemap found. Please check ${website.websiteURL.sitemapURL.toString()}`
          );
        }
      });
    });
  }
}

Website2Pdf.main().catch((error: Error) => {
  logger().error(red(`${error.message}`));
  logger().debug(error);
});

async function processSitemaps(
  cliArgs: ICliArguments,
  website: Website
): Promise<void> {
  await puppeteer
    .launch(puppeteerBrowserLaunchArgs(cliArgs.chromiumFlags))
    .then(async browser => {
      await browser
        .version()
        .then(version => {
          logger().debug(`Starting browser instance: ${version}`);
        })
        .then(async () => {
          await browser
            .createIncognitoBrowserContext()
            .then(async browserContext => {
              logger().debug(
                `Creating incognito browser context: ${browserContext.isIncognito()}`
              );
              await PromisePool.for(website.sitemaps)
                .withConcurrency(1)
                .process(async (sitemap, index) => {
                  logger().debug(
                    `Processing pool for sitemap ${sitemap.rootUrl.href} (${index}/${website.sitemaps.length}))`
                  );
                  await processSitemap(
                    cliArgs,
                    website,
                    sitemap,
                    browserContext
                  );
                });
            });
        })
        .finally(async () => {
          PrintResults.printResults();
          await browser.close();
        });
    });
}

async function processSitemap(
  cliArgs: ICliArguments,
  website: Website,
  sitemap: WebsiteSitemap,
  browserContext: puppeteer.BrowserContext
) {
  if (sitemap.urls.length !== 0) {
    const outputDir = path.normalize(cliArgs.outputDir.toString());
    await sitemapToPDF(
      browserContext,
      cliArgs,
      outputDir,
      sitemap,
      website.pdfTemplate
    );
  } else {
    logger().warn(
      `No URLs found for sitemap ${sitemap.rootUrl.toString()}. Please check ${website.websiteURL.sitemapURL.toString()}`
    );
  }
}

async function sitemapToPDF(
  browserContext: puppeteer.BrowserContext,
  cliArgs: ICliArguments,
  outputDir: string,
  sitemap: WebsiteSitemap,
  pdfTemplate: PdfTemplate
): Promise<void> {
  await fs
    .ensureDir(outputDir)
    .then((result: any) => {
      result
        ? logger().debug(`Directory ${result} created`)
        : logger().debug(`Directory ${outputDir} already exists`);
    })
    .then(async () => {
      logger().info(`Printing ${sitemap.urls.length} PDF(s) to ${outputDir}`);
      await PromisePool.for(sitemap.urls)
        .withConcurrency(cliArgs.processPool)
        .process(async (url, index) => {
          logger().debug(
            `Processing pool for url ${url.href} (${index}/${sitemap.urls.length}))`
          );
          await pageToPDF(browserContext, cliArgs, outputDir, url, pdfTemplate);
        });
    });
}

async function pageToPDF(
  browserContext: puppeteer.BrowserContext,
  cliArgs: ICliArguments,
  outputDir: string,
  url: URL,
  pdfTemplate: PdfTemplate
): Promise<void> {
  await browserContext.newPage().then(async page => {
    page.setDefaultNavigationTimeout(0);
    const metadatas = new Map<string, string>();
    const fileDir = path.join(outputDir, toFilePath(url));
    await fs
      .ensureDir(fileDir)
      .then((result: any) => {
        result
          ? logger().debug(`Directory ${result} created`)
          : logger().debug(`Directory ${outputDir} already exists`);
      })
      .then(async () => {
        await page
          .goto(url.toString(), {waitUntil: 'networkidle2'})
          .then(() => {
            page.title().then(title => {
              metadatas.set('title', title);
            });
          })
          .then(() => {
            return page
              .$$eval('meta', metas =>
                metas
                  .filter(meta => meta !== null)
                  .map(meta => {
                    const metaName = meta.getAttribute('name');
                    return metaName
                      ? [metaName, meta.getAttribute('content')]
                      : null;
                  })
              )
              .then(metas => {
                metas.forEach(meta => {
                  if (meta) metadatas.set(meta[0]!, meta[1]!);
                });
                return metadatas;
              });
          })
          .then(async metadatas => {
            const filePath = path.join(
              fileDir,
              `${toFilename(
                metadatas.get('title')?.toString(),
                cliArgs.safeTitle
              )}.pdf`
            );
            logger().debug(`Printing page ${filePath} from url ${url}`);
            await page
              .pdf({
                timeout: 0,
                path: filePath,
                format: 'a4',
                displayHeaderFooter: cliArgs.displayHeaderFooter,
                headerTemplate: interpolate(pdfTemplate.header, metadatas),
                footerTemplate: interpolate(pdfTemplate.footer, metadatas),
                margin: {
                  top: cliArgs.marginTop,
                  bottom: cliArgs.marginBottom,
                  left: cliArgs.marginLeft,
                  right: cliArgs.marginRight,
                },
                printBackground: true,
              })
              .then(() => {
                PrintResults.storeResult(url, filePath, STATUS_PRINTED);
              })
              .catch((error: Error) => {
                PrintResults.storeResult(url, filePath, STATUS_ERROR);
                throw error;
              });
          })
          .finally(async () => {
            await page.close();
          });
      });
  });
}
