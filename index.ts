import * as fs from "fs-extra";
import * as path from "path";
import * as RSS from "rss";
import * as dotenv from "dotenv";
import { v4 as uuid } from "uuid";
import chokidar from "chokidar";

dotenv.config();

const mainDirectory = process.env.MAIN_DIRECTORY;
const rootShareUrl = process.env.ROOT_SHARE_URL;
const ignoreChangedLinesIncluding = ["<lastBuildDate>"];
const dateRegex =
  /(?<y1>\d{4})\D{1,3}(?<m1>\d{1,2})\D{1,3}(?<d1>\d{1,2})|(?<d2>\d{1,2})\D{1,3}(?<m2>\d{1,2})\D{1,3}(?<y2>\d{4})/;
const dateStandard = "Y.M.D";
const rerunInterval = 1000 * 60 * 60 * 4; // 4 hours
const defaultMetadata = {
  coverUrl: generateUrlPath("cover.png"),
  websiteUrl: "https://example.com",
  categories: ["Religion & Spirituality", "Education"],
  prefixPriority: [] as string[],
};

if (process.argv.includes("--watch")) {
  if (!mainDirectory) {
    throw new Error("MAIN_DIRECTORY environment variable is not set.");
  }
  console.log(
    `Watching for changes in the main directory: ${mainDirectory} \nIgnoring changes in lines including: ${ignoreChangedLinesIncluding.join(
      ", "
    )}`
  );
  let generatingFeeds = false;
  generateFeeds(process.argv.includes("--refresh")).then(() => {
    const watcher = chokidar.watch(mainDirectory, {
      usePolling: true,
      interval: 1000 * 5,
      binaryInterval: 1000 * 60 * 30,
      ignoreInitial: true,
      awaitWriteFinish: true,
    });
    setInterval(async () => {
      if (!generatingFeeds) {
        console.log("Interval feeds generation...");
        generatingFeeds = true;
        await generateFeeds();
        generatingFeeds = false;
      }
    }, rerunInterval);
    watcher.on("all", async (_event, pathName) => {
      if (generatingFeeds) {
        return;
      }
      generatingFeeds = true;
      if (pathName) {
        console.log(`File ${pathName} changed. Generating feeds...`);
        await generateFeeds();
      }
      generatingFeeds = false;
    });
  });
} else {
  generateFeeds(process.argv.includes("--refresh"));
}

async function generateFeeds(refresh = false) {
  try {
    if (!mainDirectory) {
      throw new Error("MAIN_DIRECTORY environment variable is not set.");
    }
    if (!rootShareUrl) {
      throw new Error("NEXT_CLOUD_ROOT_SHARE environment variable is not set.");
    }

    // Read or create metadata.json file for default values
    const metadata = await readCreateJsonSafe<typeof defaultMetadata>(
      path.join(mainDirectory, "metadata.json"),
      defaultMetadata
    );

    const folders = await fs.readdir(mainDirectory);
    const feedURLS: {
      [priority: number]: string[];
    } = {};

    const reversedPrefixPriority = metadata.prefixPriority.reverse();

    for (const folder of folders) {
      const folderPath = path.join(mainDirectory, folder);
      const stat = await fs.stat(folderPath);

      // Process only directories
      if (stat.isDirectory()) {
        const feedURL = await generateFeedForFolder(
          folderPath,
          folder,
          metadata,
          refresh
        );

        // push to feedURLS by priority
        const priority = reversedPrefixPriority.findIndex((prefix) =>
          folder.split("-")[0]?.trim().includes(prefix)
        );

        if (!feedURLS[priority]) {
          feedURLS[priority] = [];
        }
        feedURLS[priority].push(feedURL);
      }
    }

    // Save all feed URLs to a text file
    await writeFileIfChanged(
      path.join(mainDirectory, "feed_urls.txt"),
      Object.entries(feedURLS)
        .sort(
          ([priority1], [priority2]) => Number(priority1) - Number(priority2)
        )
        .reverse()
        .map(([_, urls]) => urls.join("\n"))
        .join("\n")
    );
    console.log("All RSS feeds generated successfully!");
  } catch (error) {
    console.error("Error generating feeds:", error);
  }
}

// Helper function to generate an RSS feed for each podcast folder
async function generateFeedForFolder(
  folderPath: string,
  folderName: string,
  metadata: typeof defaultMetadata,
  refresh = false
) {
  const files = await fs.readdir(folderPath);

  // Find the cover image ending with .jpg or .png and rename it to cover.*
  let coverUrl = metadata.coverUrl;
  for (const file of files) {
    if (file.endsWith(".jpg") || file.endsWith(".png")) {
      // rename the file to cover.*
      const extension = file.endsWith(".jpg") ? ".jpg" : ".png";
      const coverImageFilePath = path.join(folderPath, `cover${extension}`);
      if (file !== `cover${extension}`) {
        await fs.rename(path.join(folderPath, file), coverImageFilePath);
      }
      coverUrl = generateUrlPath(`${folderName}/cover${extension}`);
      break;
    }
  }

  // Find or create the metadata.json file
  let channelMetadata = {
    title: folderName,
    description: folderName,
    site_url: metadata.websiteUrl,
    categories: metadata.categories,
    explicit: false,
    guid: uuid(),
    pubDate: new Date().toISOString(),
    itemMetadata: {} as ItemMetadata,
  };
  type ItemMetadata = Record<
    string,
    {
      title: string;
      description: string;
      guid: string;
      date: string;
      duration: number;
    }
  >;
  const channelMetadataFilePath = path.join(folderPath, "metadata.json");
  if (refresh) {
    // Remove all files that include metadata.json
    for (const file of files) {
      if (file.includes("metadata.json")) {
        await fs.remove(path.join(folderPath, file));
      }
    }
  }
  channelMetadata = await readCreateJsonSafe<typeof channelMetadata>(
    channelMetadataFilePath,
    channelMetadata
  );

  // Strip folder name from priority prefixes separated by '-'
  channelMetadata.title = folderName
    .split("-")
    .filter(
      (part) =>
        metadata.prefixPriority.findIndex(
          (prefix) =>
            part.toLocaleLowerCase().trim() ===
            prefix.toLocaleLowerCase().trim()
        ) === -1
    )
    .join("-")
    .trim();

  // Find description.txt file and use it as the podcast description if exists
  const descriptionFilePath = path.join(folderPath, "description.txt");
  channelMetadata.description = `${channelMetadata.title}`;
  try {
    if (await fs.exists(descriptionFilePath)) {
      channelMetadata.description = await fs.readFile(
        descriptionFilePath,
        "utf-8"
      );
    }
  } catch (error) {
    console.error(
      "Error reading description file, falling back to folder name:",
      error
    );
  }

  writeJsonIfChanged(channelMetadataFilePath, channelMetadata);

  console.log(`Generating RSS feed for podcast: ${channelMetadata.title}`);

  const feed = new RSS({
    ...channelMetadata,
    feed_url: generateUrlPath(`${folderName}/feed.xml`),
    image_url: coverUrl,
    language: "en",
    custom_namespaces: {
      itunes: "http://www.itunes.com/dtds/podcast-1.0.dtd",
      podcast: "https://podcastindex.org/namespace/1.0",
      atom: "http://www.w3.org/2005/Atom",
      content: "http://purl.org/rss/1.0/modules/content/",
    },
    custom_elements: [
      ...channelMetadata.categories.map((category) => ({
        "itunes:category": { _attr: { text: category } },
      })),
      { "itunes:explicit": channelMetadata.explicit ? "true" : "false" },
      { "itunes:image": { _attr: { href: coverUrl } } },
      { "podcast:guid": channelMetadata.guid },
    ],
  });

  // Move all MP3 files to the "items" folder
  const itemsFolder = path.join(folderPath, "items");
  await fs.ensureDir(itemsFolder);
  const mp3FilesToMove = files.filter((file) => file.endsWith(".mp3"));
  for (const file of mp3FilesToMove) {
    await fs.move(path.join(folderPath, file), path.join(itemsFolder, file), {
      overwrite: true,
    });
  }

  // Try parsing date form name if exists
  const mp3Files = (await fs.readdir(itemsFolder)).filter((file) =>
    file.endsWith(".mp3")
  );
  for (const file of mp3Files) {
    const { date, title } = tryParsingDateFromName(file);
    if (date && title) {
      channelMetadata.itemMetadata[file] = {
        ...channelMetadata.itemMetadata[file],
        date: date.toISOString(),
        title: path.basename(title, ".mp3"),
      };

      // Rename the file with new standard date format
      const formattedDate = dateStandard
        .replace(/Y/, date.getFullYear().toString())
        .replace(/M/, (date.getMonth() + 1).toString().padStart(2, "0"))
        .replace(/D/, date.getDate().toString().padStart(2, "0"));
      const newFileName = `${formattedDate} - ${title}`;
      await fs.rename(
        path.join(itemsFolder, file),
        path.join(itemsFolder, newFileName)
      );
    }
  }

  // Add each MP3 file as an episode
  const sortedMP3Files = (await fs.readdir(itemsFolder))
    .filter((file) => file.endsWith(".mp3"))
    .sort((a, b) => {
      // add padded zeroes to the number parts of the file name
      a.replace(/\d+/g, (match) => match.padStart(10, "0"));
      b.replace(/\d+/g, (match) => match.padStart(10, "0"));
      // sort by file name
      if (a < b) {
        return -1;
      } else {
        return 1;
      }
    });
  const getMP3Duration = require("get-mp3-duration");
  const newItemMetadata = {} as ItemMetadata;

  for (const [index, file] of sortedMP3Files.entries()) {
    const filePath = path.join(itemsFolder, file);
    const { size } = await fs.stat(filePath);
    const url = generateUrlPath(`${folderName}/items/${file}`); // Episode URL

    // Get existing metadata or generate new metadata
    const title =
      channelMetadata.itemMetadata?.[file]?.title ??
      path.basename(file, ".mp3");
    const guid = channelMetadata.itemMetadata?.[file]?.guid || uuid();
    const description =
      channelMetadata.itemMetadata?.[file]?.description ??
      `Episode: ${index + 1}`;
    const date =
      channelMetadata.itemMetadata?.[file]?.date ??
      getNewDateString(sortedMP3Files.length - index, channelMetadata.pubDate);
    const duration =
      channelMetadata.itemMetadata?.[file]?.duration ??
      getMP3Duration(await fs.readFile(filePath));

    // Replace the metadata in the metadata.json file for existing episodes only
    newItemMetadata[file] = { description, guid, date, title, duration };

    feed.item({
      title,
      enclosure: { url, type: "audio/mpeg", size },
      guid,
      description,
      url,
      date,
      custom_elements: [
        { "itunes:duration": Math.floor(duration / 1000) },
        { "itunes:image": { _attr: { href: coverUrl } } },
        { "itunes:explicit": channelMetadata.explicit ? "true" : "false" },
      ],
    });
  }

  // Update the metadata.json file with new metadata
  await writeJsonIfChanged(channelMetadataFilePath, {
    ...channelMetadata,
    itemMetadata: newItemMetadata,
  });

  // Save the feed to an XML file
  const rssFilePath = path.join(folderPath, "feed.xml");
  await writeFileIfChanged(rssFilePath, feed.xml({ indent: true }));

  return generateUrlPath(`${folderName}/feed.xml`);
}

function tryParsingDateFromName(fileName: string) {
  try {
    const dateMatch = fileName.match(dateRegex);
    if (dateMatch) {
      const date = new Date(
        Number(dateMatch.groups?.y1 ?? dateMatch.groups?.y2),
        Number(dateMatch.groups?.m1 ?? dateMatch.groups?.m2) - 1,
        Number(dateMatch.groups?.d1 ?? dateMatch.groups?.d2)
      );
      date.toISOString();
      const title = fileName
        .replace(dateMatch[0], "")
        .replace(/^[ \-_=+;:!@#$%^&*){}\]/\\.,?|]+/, "");
      return { date, title };
    }
  } catch (error) {
    console.error("Error parsing date:", error);
  }
  return {};
}

// Helper function to generate url path for a given pathname + filename
function generateUrlPath(combinedPath: string, encode = true) {
  combinedPath = combinedPath.replace("/", path.sep);
  let folderName = path.dirname(combinedPath);
  let fileName = path.basename(combinedPath);

  if (folderName === ".") {
    folderName = "";
  } else {
    folderName = folderName + path.sep;
  }

  let finalCombinedPath = folderName + fileName;
  if (encode) {
    finalCombinedPath = finalCombinedPath
      .split(path.sep)
      .map(encodeURIComponent)
      .join("/");
  }

  return `${rootShareUrl}/${finalCombinedPath}`;
}

function getNewDateString(index: number, referenceDate: string) {
  try {
    const date = new Date(referenceDate);
    date.setTime(date.getTime() - index * 10000);
    return date.toISOString();
  } catch (error) {
    console.error("Error parsing date:", error);
    const date = new Date();
    date.setTime(date.getTime() - index * 10000);
    return date.toISOString();
  }
}

async function readCreateJsonSafe<T>(
  path: string,
  defaultValue: T
): Promise<T> {
  if (await fs.exists(path)) {
    try {
      const value = {
        ...defaultValue,
        ...(await fs.readJson(path)),
      };
      await writeJsonIfChanged(path, value);
      return value;
    } catch (error) {
      // Backup the errored file and append error message
      const errorFilePath = path + ".error.txt";
      await fs.appendFile(
        errorFilePath,
        "ERROR HAPPENED:\n\n" +
          (await fs.readFile(path)) +
          "\n" +
          error +
          "\n\n"
      );

      // Write a new file with default values
      await writeJsonIfChanged(path, defaultValue);
      return defaultValue;
    }
  } else {
    await writeJsonIfChanged(path, defaultValue);
    return defaultValue;
  }
}

async function writeJsonIfChanged<T>(path: string, value: T) {
  let oldValue: T | undefined;
  try {
    oldValue = await fs.readJson(path);
  } catch (error) {
    oldValue = undefined;
  }
  if (oldValue && value && JSON.stringify(oldValue) === JSON.stringify(value)) {
    return;
  }
  await fs.writeJson(path, value, { spaces: 2 });
}

async function writeFileIfChanged(path: string, value: string) {
  let oldValue: string | undefined;
  try {
    oldValue = await fs.readFile(path, "utf-8");
  } catch (error) {
    oldValue = undefined;
  }
  if (oldValue === value) {
    return;
  }
  const changedLines = getChangedLines(oldValue, value);
  const changesExceptIgnored = changedLines.filter(
    (change) =>
      !ignoreChangedLinesIncluding.some(
        (ignore) => change.old.includes(ignore) && change.new.includes(ignore)
      )
  );
  if (changesExceptIgnored.length === 0) {
    return;
  }

  console.log(`Writing file: ${path}`);
  console.log(
    "Old: ",
    changedLines.reduce((acc, change) => acc + change.old + "\n", "")
  );
  console.log(
    "New: ",
    changedLines.reduce((acc, change) => acc + change.new + "\n", "")
  );
  await fs.writeFile(path, value);
}

function getChangedLines(
  oldValue: string = "",
  newValue: string,
  lookAheadLimit = 100
): { old: string; new: string }[] {
  const oldLines = oldValue.split("\n");
  const newLines = newValue.split("\n");

  const changes: { old: string; new: string }[] = [];

  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i >= oldLines.length) {
      // Remaining lines in new file (added lines)
      changes.push({ old: "", new: newLines[j] });
      j++;
    } else if (j >= newLines.length) {
      // Remaining lines in old file (removed lines)
      changes.push({ old: oldLines[i], new: "" });
      i++;
    } else if (oldLines[i] === newLines[j]) {
      // Matching lines, move both pointers
      i++;
      j++;
    } else {
      // Check for line shifts or edits
      let foundMatch = false;

      // Look ahead in the new file for a match (line added)
      for (
        let lookAhead = 1;
        lookAhead <= lookAheadLimit && j + lookAhead < newLines.length;
        lookAhead++
      ) {
        if (oldLines[i] === newLines[j + lookAhead]) {
          // Lines were added in the new file
          for (let k = 0; k < lookAhead; k++) {
            changes.push({ old: "", new: newLines[j + k] });
          }
          j += lookAhead;
          foundMatch = true;
          break;
        }
      }

      // Look ahead in the old file for a match (line removed)
      if (!foundMatch) {
        for (
          let lookAhead = 1;
          lookAhead <= lookAheadLimit && i + lookAhead < oldLines.length;
          lookAhead++
        ) {
          if (oldLines[i + lookAhead] === newLines[j]) {
            // Lines were removed in the old file
            for (let k = 0; k < lookAhead; k++) {
              changes.push({ old: oldLines[i + k], new: "" });
            }
            i += lookAhead;
            foundMatch = true;
            break;
          }
        }
      }

      // If still no match, it's a modified line
      if (!foundMatch) {
        changes.push({ old: oldLines[i], new: newLines[j] });
        i++;
        j++;
      }
    }
  }

  return changes;
}
