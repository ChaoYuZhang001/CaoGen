import { z } from 'zod'
import type { GeneratedOfficeArtifact, OfficeArtifactToolName } from './tools/office-artifact'

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')
type OfficeExecutor = (
  toolName: OfficeArtifactToolName,
  input: Record<string, unknown>
) => Promise<GeneratedOfficeArtifact>

const sourceRefs = z.array(z.string().max(1_024)).max(200).optional()
const scalar = z.union([z.string().max(100_000), z.number().finite(), z.boolean()])
const cell = z.union([
  scalar,
  z.object({
    formula: z.string().min(1).max(8_192),
    result: scalar.optional()
  }).strict()
])

export function createClaudeOfficeMcpServer(sdk: ClaudeSdk, execute: OfficeExecutor) {
  return sdk.createSdkMcpServer({
    name: 'caogen-office',
    version: '1.0.0',
    instructions:
      'Use these tools when the user asks for a deliverable Word, Excel, PowerPoint, or PDF file. Outputs stay inside the current CaoGen workspace and enter the durable Artifact/Evidence/Acceptance chain.',
    alwaysLoad: true,
    tools: [
      sdk.tool(
        'create_document',
        'Generate a deliverable Word .docx file in the current workspace. Existing files are never overwritten.',
        {
          path: z.string().min(1).max(1_024),
          title: z.string().min(1).max(240),
          headings: z.array(z.string().max(100_000)).max(200).optional(),
          paragraphs: z.array(z.string().max(100_000)).max(5_000).optional(),
          source_refs: sourceRefs
        },
        async (input) => officeResult(await execute('create_document', input)),
        {
          alwaysLoad: true,
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
        }
      ),
      sdk.tool(
        'create_spreadsheet',
        'Generate a deliverable Excel .xlsx workbook in the current workspace. Supports multiple sheets and formulas; existing files are never overwritten.',
        {
          path: z.string().min(1).max(1_024),
          title: z.string().min(1).max(240),
          sheets: z.array(z.object({
            name: z.string().min(1).max(31),
            rows: z.array(z.array(cell).max(16_384)).max(50_000)
          }).strict()).min(1).max(100),
          source_refs: sourceRefs
        },
        async (input) => officeResult(await execute('create_spreadsheet', input)),
        {
          alwaysLoad: true,
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
        }
      ),
      sdk.tool(
        'create_presentation',
        'Generate a deliverable PowerPoint .pptx presentation in the current workspace. Existing files are never overwritten.',
        {
          path: z.string().min(1).max(1_024),
          title: z.string().min(1).max(240),
          slides: z.array(z.object({
            title: z.string().min(1).max(240),
            body: z.string().max(20_000).optional(),
            bullets: z.array(z.string().max(100_000)).max(100).optional()
          }).strict()).min(1).max(100),
          source_refs: sourceRefs
        },
        async (input) => officeResult(await execute('create_presentation', input)),
        {
          alwaysLoad: true,
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
        }
      ),
      sdk.tool(
        'create_pdf',
        'Generate a deliverable PDF in the current workspace with embedded Chinese font support. Existing files are never overwritten.',
        {
          path: z.string().min(1).max(1_024),
          title: z.string().min(1).max(240),
          sections: z.array(z.object({
            heading: z.string().max(240).optional(),
            paragraphs: z.array(z.string().max(100_000)).max(1_000).optional()
          }).strict()).min(1).max(500),
          source_refs: sourceRefs
        },
        async (input) => officeResult(await execute('create_pdf', input)),
        {
          alwaysLoad: true,
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
        }
      )
    ]
  })
}

function officeResult(artifact: GeneratedOfficeArtifact) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        path: artifact.path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        mediaType: artifact.mediaType,
        artifactKind: artifact.artifactKind,
        title: artifact.title,
        sourceRefs: artifact.sourceRefs
      })
    }]
  }
}
