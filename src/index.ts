import { type SQSEvent, type EventBridgeEvent } from "aws-lambda";
import pg, { type QueryResult, type QueryResultRow } from "pg";
import Cursor from "pg-cursor";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { Octokit } from "@octokit/rest" with { "resolution-mode": "import" };

type ScheduledEvent = EventBridgeEvent<"Scheduled Event", unknown>;

// This mess is required because @octokit/rest is ESM only and AWS Lambda on docker requires CJS.
let _client: Octokit;
async function getGithubClient() {
  if (_client) return _client;

  const { Octokit } = await import("@octokit/rest");
  _client = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });
  return _client;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL env var missing");
}
const dbClient = new pg.Pool({ connectionString, max: 1 });

export async function query<T extends QueryResultRow>(
  text: string,
  params: any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<QueryResult<T>> {
  return dbClient.query(text, params);
}

export async function* queryCursor<T extends QueryResultRow>(
  text: string,
  params: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  batchSize = 1,
): AsyncGenerator<T> {
  const client = await dbClient.connect();
  try {
    const cursor = client.query(new Cursor<T>(text, params));

    let size = 0;
    do {
      const rows = await cursor.read(batchSize);
      size = rows.length;

      for (const row of rows) {
        yield row;
      }
    } while (size > 0);
  } finally {
    client.release();
  }
}

export async function handler(event: SQSEvent | ScheduledEvent) {
  if ("Records" in event) {
    const message = JSON.parse(event.Records[0].body) as { code: string };
    await exportLanguage(message.code);
  } else if ("detail-type" in event) {
    await queueLanguages();
  }
}

async function queueLanguages() {
  const languages = await fetchUpdatedLanguages();
  if (languages.length === 0) {
    console.log("No languages to export to GitHub");
    return;
  }

  const sqsClient = new SQSClient();
  await sqsClient.send(
    new SendMessageBatchCommand({
      QueueUrl: process.env.GITHUB_EXPORT_QUEUE_URL,
      Entries: languages.map((language) => ({
        MessageGroupId: "github-export",
        Id: language.code,
        MessageBody: JSON.stringify({
          code: language.code,
        }),
      })),
    }),
  );

  console.log(`Queued the following languages for export to GitHub:
${languages.map((language) => language.code).join("\n")}`);
}

async function exportLanguage(code: string) {
  console.log(`Starting export of language ${code}`);

  console.log("Creating blob for each book");
  const treeItems = [];
  for await (const book of fetchLanguageData(code)) {
    const treeItem = await createBlobForBook(code, book);
    treeItems.push(treeItem);
  }

  console.log("Creating tree");
  const treeSha = await createTree(treeItems);

  console.log("Creating commit");
  await createCommit(code, treeSha);

  console.log("Export complete");
}

async function fetchUpdatedLanguages() {
  const result = await query<{ code: string }>(
    `SELECT DISTINCT lang.code FROM gloss
        JOIN phrase ph ON ph.id = gloss.phrase_id
        JOIN language lang ON lang.id = ph.language_id
        WHERE gloss.updated_at >= NOW() - INTERVAL '8 days'
            OR ph.deleted_at >= NOW() - INTERVAL '8 days'
        ORDER BY lang.code
        `,
    [],
  );
  return result.rows;
}

interface Word {
  id: string;
  gloss: string | null;
}

interface Verse {
  id: string;
  words: Word[];
}

interface Chapter {
  id: string;
  verses: Verse[];
}

interface Book {
  id: string;
  name: string;
  chapters: Chapter[];
}

function fetchLanguageData(languageId: string) {
  return queryCursor<Book>(
    `SELECT
            book.id,
            book.name,
            JSON_AGG(JSON_BUILD_OBJECT(
                'id', book_chapters.chapter,
                'verses', book_chapters.verses
            ) ORDER BY book_chapters.chapter) AS chapters
        FROM book
        JOIN (
            SELECT
                verse.book_id,
                verse.chapter,
                JSON_AGG(JSON_BUILD_OBJECT(
                    'id', verse.id,
                    'words', verse_words.words
                ) ORDER BY verse.id) AS verses
            FROM verse
            JOIN (
                SELECT
                    word.verse_id,
                    JSON_AGG(JSON_BUILD_OBJECT(
                        'id', word.id,
                        'gloss', gloss.gloss
                    ) ORDER BY word.id) AS words
                FROM word
                LEFT JOIN LATERAL (
                    SELECT gloss.gloss FROM gloss
                    WHERE gloss.state = 'APPROVED'
                        AND EXISTS (
                            SELECT FROM phrase_word 
                            JOIN phrase ON phrase_word.phrase_id = phrase.id
                            WHERE phrase.language_id = (SELECT id FROM language WHERE code = $1)
                                AND phrase.deleted_at IS NULL
                                AND phrase_word.word_id = word.id
                                AND gloss.phrase_id = phrase.id
                        )
                ) gloss ON true
                GROUP BY word.verse_id
            ) verse_words ON verse.id = verse_words.verse_id
            GROUP BY verse.book_id, verse.chapter
        ) book_chapters ON book_chapters.book_id = book.id
        GROUP BY book.id
        `,
    [languageId],
  );
}

const GH_OWNER = "globalbibletools";
const GH_REPO = "data";
const GH_BRANCH = "main";

interface TreeItem {
  path?: string;
  mode?: "100644" | "100755" | "040000" | "160000" | "120000";
  type?: "blob" | "tree" | "commit";
  sha?: string | null;
  content?: string;
}

async function createBlobForBook(
  languageCode: string,
  book: Book,
): Promise<TreeItem> {
  const client = await getGithubClient();

  const result = await client.git.createBlob({
    owner: GH_OWNER,
    repo: GH_REPO,
    content: JSON.stringify(book, null, 2),
    encoding: "utf-8",
  });
  return {
    path: `${languageCode}/${book.id.toString().padStart(2, "0")}-${book.name}.json`,
    mode: "100644",
    type: "blob",
    sha: result.data.sha,
  };
}

async function createTree(items: TreeItem[]): Promise<string> {
  const client = await getGithubClient();

  const result = await client.git.getTree({
    owner: GH_OWNER,
    repo: GH_REPO,
    tree_sha: GH_BRANCH,
  });

  const treeResult = await client.git.createTree({
    owner: GH_OWNER,
    repo: GH_REPO,
    base_tree: result.data.sha,
    tree: items,
  });
  return treeResult.data.sha;
}

async function createCommit(code: string, treeSha: string) {
  const client = await getGithubClient();

  const parentResult = await client.git.getRef({
    owner: GH_OWNER,
    repo: GH_REPO,
    ref: `heads/${GH_BRANCH}`,
  });

  const commitResult = await client.git.createCommit({
    owner: GH_OWNER,
    repo: GH_REPO,
    tree: treeSha,
    message: `Export from Global Bible Tools for ${code}`,
    parents: [parentResult.data.object.sha],
  });

  await client.git.updateRef({
    owner: GH_OWNER,
    repo: GH_REPO,
    ref: `heads/${GH_BRANCH}`,
    sha: commitResult.data.sha,
  });
}
