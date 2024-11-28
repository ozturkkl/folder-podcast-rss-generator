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
  /(?<y1>\d{4}).{1,3}(?<m1>\d{1,2}).{1,3}(?<d1>\d{1,2})|(?<d2>\d{1,2}).{1,3}(?<m2>\d{1,2}).{1,3}(?<y2>\d{4})/;
const dateStandard = "Y.M.D";

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
      interval: 3000,
      persistent: true,
      ignoreInitial: true,
    });
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
    const defaultMetadata = {
      coverUrl: generateUrlPath("cover.png"),
      websiteUrl: "https://example.com",
      categories: ["Religion & Spirituality", "Education"],
    };
    const metadata = await readCreateJsonSafe<typeof defaultMetadata>(
      path.join(mainDirectory, "metadata.json"),
      defaultMetadata
    );

    const folders = await fs.readdir(mainDirectory);
    const feedURLS = [];

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
        feedURLS.push(feedURL);
      }
    }

    // Save all feed URLs to a text file
    await writeFileIfChanged(
      path.join(mainDirectory, "feed_urls.txt"),
      feedURLS.map((url) => url).join("\n")
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
  metadata: {
    coverUrl: string;
    websiteUrl: string;
    categories: string[];
  },
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
      coverUrl = generateUrlPath(`${folderName}/${file}`);
      break;
    }
  }

  // Find or create the metadata.json file
  let channelMetadata = {
    title: folderName,
    description: `${folderName}`,
    site_url: metadata.websiteUrl,
    categories: metadata.categories,
    explicit: false,
    guid: uuid(),
    date: new Date().toISOString(),
    itemMetadata: {} as ItemMetadata,
  };
  type ItemMetadata = Record<
    string,
    {
      title: string;
      description: string;
      guid: string;
      date: string;
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
    categories: channelMetadata.categories,

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
      // add code to fix not having padded zeros
      const aNumberPart = a.match(/\d+/);
      const bNumberPart = b.match(/\d+/);
      if (aNumberPart && bNumberPart) {
        return parseInt(aNumberPart[0]) - parseInt(bNumberPart[0]);
      }
      return 0;
    });
  const getMP3Duration = require("get-mp3-duration");
  const newItemMetadata = {} as ItemMetadata;

  for (const [index, file] of sortedMP3Files.entries()) {
    const filePath = path.join(itemsFolder, file);
    const stat = await fs.stat(filePath);
    const fileUrl = generateUrlPath(`${folderName}/items/${file}`); // Episode URL
    const buffer = await fs.readFile(filePath);
    const durationMS = getMP3Duration(buffer);

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
      getNewDateString(sortedMP3Files.length - index, channelMetadata.date);

    // Replace the metadata in the metadata.json file for existing episodes only
    newItemMetadata[file] = { description, guid, date, title };

    feed.item({
      title,
      enclosure: { url: fileUrl, type: "audio/mpeg", size: stat.size },
      guid,
      description,
      url: fileUrl,
      date,
      custom_elements: [
        { "itunes:duration": Math.floor(durationMS / 1000) },
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
  console.log(`Generated RSS feed for podcast: ${folderName}`);

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

async function readCreateJsonSafe<T>(path: string, defaultValue: T) {
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
    changedLines.reduce((acc, change) => acc + change.old, "")
  );
  console.log(
    "New: ",
    changedLines.reduce((acc, change) => acc + change.new, "")
  );
  await fs.writeFile(path, value);
}

function getChangedLines(oldValue = "", newValue: string) {
  let changes: {
    old: string;
    new: string;
  }[] = [];
  for (let i = 0; i < Math.min(oldValue.length, newValue.length); i++) {
    if (oldValue[i] !== newValue[i]) {
      let start = i;
      let end = i;
      while (oldValue[start] !== "\n" && start > 0) {
        start--;
      }
      while (oldValue[end] !== "\n" && end < oldValue.length) {
        end++;
      }
      changes.push({
        old: oldValue.substring(start, end),
        new: newValue.substring(start, end),
      });

      i = end;
    }
  }

  if (oldValue.length !== newValue.length) {
    changes.push({
      old: oldValue.substring(
        Math.min(oldValue.length, newValue.length),
        oldValue.length
      ),
      new: newValue.substring(
        Math.min(oldValue.length, newValue.length),
        newValue.length
      ),
    });
  }
  return changes;
}
