import fs from "fs-extra";
import path from "path";
import RSS from "rss";
import dotenv from "dotenv";

dotenv.config();

// Main directory containing all shows
const mainDirectory = process.env.MAIN_DIRECTORY;
const nextCloudRootShare = process.env.NEXT_CLOUD_ROOT_SHARE;
const defaultWebsite = process.env.DEFAULT_WEBSITE ?? "https://example.com";

// Helper function to generate url path for a given pathname + filename
const generateUrlPath = (combinedPath: string, encode = true) => {
  const folderName =
    path.dirname(combinedPath) !== "." ? path.dirname(combinedPath) : "";
  const fileName = path.basename(combinedPath);

  return `${nextCloudRootShare}/download?path=${
    encode ? encodeURIComponent(folderName) : folderName
  }&files=${encode ? encodeURIComponent(fileName) : fileName}`;
};

// Helper function to generate an RSS feed for each podcast folder
const generateFeedForFolder = async (
  folderPath: string,
  folderName: string
) => {
  // Read files in the folder
  const files = await fs.readdir(folderPath);

  // find the cover image ending with .jpg or .png
  let coverImage: string | undefined = undefined;
  for (const file of files) {
    if (file.endsWith(".jpg") || file.endsWith(".png")) {
      coverImage = generateUrlPath(`${folderName}/${file}`);
      break;
    }
  }

  const feed = new RSS({
    title: folderName,
    description: `${folderName}`,
    feed_url: generateUrlPath(`${folderName}/feed.xml`),
    site_url: defaultWebsite,
    image_url: coverImage,
    language: "en",
  });

  // Add each MP3 file as an episode
  for (const file of files) {
    const filePath = path.join(folderPath, file);
    const stat = await fs.stat(filePath);

    if (file.endsWith(".mp3")) {
      const fileTitle = path.basename(file, ".mp3"); // Episode title
      const fileUrl = generateUrlPath(`${folderName}/${file}`); // Episode URL

      feed.item({
        title: fileTitle,
        description: `Episode: ${fileTitle}`,
        url: fileUrl,
        date: new Date(),
        enclosure: { url: fileUrl, type: "audio/mpeg" },
      });
    }
  }

  // Save the feed to an XML file
  const rssFilePath = path.join(folderPath, "feed.xml");
  await fs.writeFile(rssFilePath, feed.xml({ indent: true }));
  console.log(`Generated RSS feed for podcast: ${folderName}`);

  return {
    folderName,
    feedUrl: generateUrlPath(`${folderName}/feed.xml`),
    description: `Podcast feed for ${folderName}`,
  };
};

// Main function
const generateFeeds = async () => {
  try {
    if (!mainDirectory) {
      throw new Error("MAIN_DIRECTORY environment variable is not set.");
    }
    if (!nextCloudRootShare) {
      throw new Error("NEXT_CLOUD_ROOT_SHARE environment variable is not set.");
    }
    const folders = await fs.readdir(mainDirectory);
    const podcastFeeds = [];

    for (const folder of folders) {
      const folderPath = path.join(mainDirectory, folder);
      const stat = await fs.stat(folderPath);

      // Process only directories
      if (stat.isDirectory()) {
        const podcastFeed = await generateFeedForFolder(folderPath, folder);
        podcastFeeds.push(podcastFeed);
      }
    }

    // Save all feed URLs to a text file
    await fs.writeFile(
      path.join(mainDirectory, "feed_urls.txt"),
      podcastFeeds.map((podcast) => podcast.feedUrl).join("\n")
    );
    console.log("All RSS feeds generated successfully!");
  } catch (error) {
    console.error("Error generating feeds:", error);
  }
};

// Run the script
generateFeeds();
