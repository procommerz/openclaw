/**
 * Pushes messages to the GPT stream logger app (a standlone LLM log viewer)
 * @returns {Promise<boolean>} - True if the messages were pushed successfully, false otherwise
 */
export const logMessagesToStreamLogger = async ({
  messages,
  name,
}: {
  messages: { content: string; role: string }[];
  name: string;
}) => {
  const url = `http://192.168.0.111:9797/log`;

  const formattedMessages = messages.map((message) => {
    let content = "";

    if (typeof message.content === "string") {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      content = message.content
        .map((item) => {
          if (item.type === "text") {
            return item.text;
          } else if (item.type === "image_url") {
            return `[image]`;
          }
        })
        .join("\n");
    }

    return {
      role: message.role,
      content: content,
    };
  });

  const payload = {
    streamName: name,
    messages: formattedMessages,
  };

  // Attempt sending a post request to the stream logger:
  try {
    await fetch(url, {
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify(payload),
    });

    return true;
  } catch (error) {
    if (error instanceof Error && error.message == "fatal") {
      console.error("Failed to log GPT messages to stream logger: ", error);
    }
    return false;
  }
};
