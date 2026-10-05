import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'
import { configService } from './configService'
import { i18nService } from './i18nService'
import { APP_CONTEXT_PROMPT, AGENT_INSTRUCTIONS, NO_PROJECT_INSTRUCTIONS, hostOsName, hostOpenCommand } from './agentPrompt'
import { projectService } from './projectService'

export class GeminiService {
  private genAI: GoogleGenerativeAI | null = null
  private model: any = null
  private defaultModel = 'gemini-3.8-flash' // Latest stable model
  private maxTokens = 8192 // Token limit to prevent excessive usage
  private timeout = 120000 // 2 minutes timeout

  constructor() {
    this.initialize()
  }

  private getModelName(override?: string): string {
    if (override) return override
    // An organization-issued session restricts the model list server-side
    const managed = configService.getManagedCredentials()
    if (managed?.model) return managed.model
    if (managed?.models?.length) return managed.models[0]
    const model = configService.getGeminiModel()
    if (model === 'custom') {
      const customModel = configService.getGeminiCustomModel()
      return customModel || this.defaultModel
    }
    return model || this.defaultModel
  }

  private initialize(modelOverride?: string) {
    // A valid organization session takes precedence over the personal key
    const managed = configService.getManagedCredentials()
    const apiKey = managed?.apiKey || configService.getGeminiApiKey()
    const proxyUrl = managed?.proxyUrl || configService.getLlmProxyUrl()
    
    if (apiKey) {
      this.genAI = new GoogleGenerativeAI(apiKey)

      // If a LiteLLM proxy is configured, redirect requests to it.
      // SDK 0.21 has no customFetch - use baseUrl + Authorization header.
      const requestOptions = proxyUrl
        ? {
            baseUrl: proxyUrl.replace(/\/$/, ''),
            customHeaders: { 'Authorization': `Bearer ${apiKey}` },
          }
        : undefined

      const modelName = this.getModelName(modelOverride)
      this.model = this.genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          maxOutputTokens: this.maxTokens,
          temperature: 0.7,
        },
      }, requestOptions)
    }
  }

  private getModel(modelOverride?: string) {
    if (!this.model && this.genAI) {
      const modelName = this.getModelName(modelOverride)
      this.model = this.genAI.getGenerativeModel({ 
        model: modelName,
        generationConfig: {
          maxOutputTokens: this.maxTokens,
          temperature: 0.7,
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'read_file',
                description: 'Read the contents of a file',
                parameters: {
                  type: SchemaType.OBJECT,
                  properties: {
                    filePath: {
                      type: SchemaType.STRING,
                      description: 'The path to the file to read'
                    }
                  },
                  required: ['filePath']
                }
              },
              {
                name: 'write_file',
                description: 'Write content to a file',
                parameters: {
                  type: SchemaType.OBJECT,
                  properties: {
                    filePath: {
                      type: SchemaType.STRING,
                      description: 'The path to the file to write'
                    },
                    content: {
                      type: SchemaType.STRING,
                      description: 'The content to write to the file'
                    }
                  },
                  required: ['filePath', 'content']
                }
              },
              {
                name: 'list_files',
                description: 'List files in a directory',
                parameters: {
                  type: SchemaType.OBJECT,
                  properties: {
                    directoryPath: {
                      type: SchemaType.STRING,
                      description: 'The path to the directory to list'
                    }
                  },
                  required: ['directoryPath']
                }
              }
            ]
          }
        ]
      })
    }
    return this.model
  }

  // Translate LiteLLM/proxy errors into user-facing text under an
  // organization session. Returns null to keep the original message.
  private describeManagedError(errorMessage: string): string | null {
    if (!configService.getManagedCredentials()) return null
    const m = errorMessage.toLowerCase()
    if (m.includes('budget')) {
      return i18nService.t('Your allotted usage budget has been fully used. It will reset automatically, or contact your administrator.')
    }
    // Upstream provider quota/billing cap (e.g. Google AI Studio monthly
    // spend limit) - this is the whole organization, not the user's slice.
    if (m.includes('resource_exhausted') || m.includes('quota') || m.includes('exhausted') || m.includes('billing')) {
      return i18nService.t('The organization usage cap has been reached. It resets at the start of the next billing period, or contact your administrator.')
    }
    if (m.includes('rate limit') || m.includes('rate_limit') || m.includes('429')) {
      return i18nService.t('Your allotted usage limit has been reached. Please wait a moment and try again.')
    }
    if (m.includes('not allowed') || m.includes('does not have access') || m.includes('forbidden')) {
      return i18nService.t('This model is not permitted by your organization. Check the model selection in Settings.')
    }
    return null
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => 
        setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs)
      )
    ])
  }

  private async executeTool(functionCall: any): Promise<any> {
    const { name, args } = functionCall
    console.log('Executing tool:', name, args)

    switch (name) {
      case 'read_file':
        if (window.electronAPI) {
          const result = await window.electronAPI.readFile(args.filePath)
          return result
        }
        throw new Error('Electron API not available')

      case 'write_file':
        if (window.electronAPI) {
          const result = await window.electronAPI.writeFile(args.filePath, args.content)
          return result
        }
        throw new Error('Electron API not available')

      case 'list_files':
        if (window.electronAPI) {
          const result = await window.electronAPI.readDirectory(args.directoryPath)
          return result
        }
        throw new Error('Electron API not available')

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  }

  public isConfigured(): boolean {
    return !!localStorage.getItem('gemini_api_key') || !!configService.getManagedCredentials()
  }

  public async sendMessageWithTools(message: string, context?: string): Promise<{ response: string; toolCalls: any[] }> {
    if (!this.isConfigured()) {
      throw new Error(i18nService.t('Gemini API key not configured. Please set your API key in settings.'))
    }

    this.initialize()

    const model = this.getModel()
    if (!model) {
      throw new Error(i18nService.t('Failed to initialize Gemini model'))
    }

    try {
      let prompt = message
      if (context) {
        prompt = `Context:\n${context}\n\nUser message:\n${message}`
      }
      
      // Add explicit instruction to use tools - this is critical
      prompt = `INSTRUCTION: You have access to file operation tools (read_file, write_file, list_files). When the user asks you to create, read, write, or list files, you MUST call the appropriate tool function. Do not just say you will do it - actually execute the tool by calling the function.\n\n${prompt}`
      
      // Define tools for function calling using the correct format
      const tools = [
        {
          functionDeclarations: [
            {
              name: 'read_file',
              description: 'Read the contents of a file at the specified path',
              parameters: {
                type: SchemaType.OBJECT,
                properties: {
                  filePath: {
                    type: SchemaType.STRING,
                    description: 'The absolute or relative path to the file to read'
                  }
                },
                required: ['filePath']
              }
            },
            {
              name: 'write_file',
              description: 'Write content to a file at the specified path. Creates the file if it does not exist.',
              parameters: {
                type: SchemaType.OBJECT,
                properties: {
                  filePath: {
                    type: SchemaType.STRING,
                    description: 'The absolute or relative path to the file to write'
                  },
                  content: {
                    type: SchemaType.STRING,
                    description: 'The content to write to the file'
                  }
                },
                required: ['filePath', 'content']
              }
            },
            {
              name: 'list_files',
              description: 'List files and directories in the specified path',
              parameters: {
                type: SchemaType.OBJECT,
                properties: {
                  directoryPath: {
                    type: SchemaType.STRING,
                    description: 'The absolute or relative path to the directory to list'
                  }
                },
                required: ['directoryPath']
              }
            }
          ]
        }
      ]

      const result = await this.withTimeout(model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: tools
      }), this.timeout) as any
      const response = await result.response
      
      const toolCalls = response.functionCalls || []
      
      console.log('Tool calls detected:', toolCalls)
      
      // If there are tool calls, execute them and get final response
      if (toolCalls.length > 0) {
        let toolResults: any[] = []
        for (const functionCall of toolCalls) {
          try {
            const toolResult = await this.executeTool(functionCall)
            toolResults.push({
              functionResponse: toolResult,
              name: functionCall.name
            })
          } catch (toolError) {
            console.error('Tool execution error:', toolError)
            toolResults.push({
              functionResponse: { error: toolError instanceof Error ? toolError.message : 'Tool execution failed' },
              name: functionCall.name
            })
          }
        }
        
        console.log('Tool results:', toolResults)
        
        // Send tool results back to model
        const followUpResult = await model.generateContent({
          contents: [
            { role: 'user', parts: [{ text: prompt }] },
            ...response.candidates[0].content.parts,
            { role: 'function', parts: toolResults }
          ]
        })
        const followUpResponse = await followUpResult.response
        return {
          response: followUpResponse.text(),
          toolCalls
        }
      }
      
      return {
        response: response.text(),
        toolCalls
      }
    } catch (error) {
      console.error('Gemini API error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      const managedError = this.describeManagedError(errorMessage)
      if (managedError) throw new Error(managedError)
      throw new Error(`${i18nService.t('Failed to get response from Gemini')}: ${errorMessage}`)
    }
  }

  public async sendMessage(message: string, context?: string, history: Array<{role: string, content: string}> = [], modelOverride?: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(i18nService.t('Gemini API key not configured. Please set your API key in settings.'))
    }

    // Reinitialize in case API key was updated
    this.initialize(modelOverride)

    const model = this.getModel(modelOverride)
    if (!model) {
      throw new Error(i18nService.t('Failed to initialize Gemini model'))
    }

    try {
      let prompt = message
      if (context) {
        prompt = `Context:\n${context}\n\nUser message:\n${message}`
      }
      
      // Host-app identity so the model answers for THIS editor, not VS Code
      prompt += APP_CONTEXT_PROMPT
      const projectOpen = !!projectService.getCurrentProject()?.isOpen
      prompt += `\nThe app runs on ${hostOsName()}.`
      prompt += projectOpen
        ? ` To open a file/URL in the browser, emit "// RUN_COMMAND: ${hostOpenCommand()} <target>".\n`
        : '\n'

      // Add instruction for file operations using simple commands - or warn
      // that they are unavailable when no project is open
      prompt += projectOpen ? AGENT_INSTRUCTIONS : NO_PROJECT_INSTRUCTIONS

      // Build conversation history for Gemini
      const contents = []

      // Add history if provided
      if (history.length > 0) {
        for (const msg of history) {
          if (msg.role === 'user') {
            contents.push({ role: 'user', parts: [{ text: msg.content }] })
          } else if (msg.role === 'assistant') {
            contents.push({ role: 'model', parts: [{ text: msg.content }] })
          }
        }
      }

      // Add current message
      contents.push({ role: 'user', parts: [{ text: prompt }] })

      const result = await this.withTimeout(model.generateContent({ contents }), this.timeout) as any
      const response = await result.response
      
      return response.text()
    } catch (error) {
      console.error('Gemini API error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      const managedError = this.describeManagedError(errorMessage)
      if (managedError) throw new Error(managedError)

      // Check if it's a timeout error
      if (errorMessage.includes('timeout')) {
        throw new Error(i18nService.t('Request timed out. The AI response took too long. Try with a simpler prompt or check your internet connection.'))
      }

      // Check if it's a model not found error and try fallback.
      // Skipped in managed mode: the organization controls the model list,
      // and the fallback must not rewrite the personal model setting.
      if (!configService.getManagedCredentials() && (errorMessage.includes('not found') || errorMessage.includes('is not supported'))) {
        const currentModel = this.getModelName()
        console.log(`Model '${currentModel}' not available, trying fallback...`)
        localStorage.setItem('gemini_model', 'gemini-1.5-flash') // Try fallback
        this.initialize()
        const fallbackModel = this.getModel()
        if (fallbackModel) {
          try {
            const result = await this.withTimeout(fallbackModel.generateContent(prompt), this.timeout) as any
            const response = await result.response
            return response.text()
          } catch (fallbackError) {
            // Restore original model setting
            localStorage.setItem('gemini_model', currentModel)
            throw new Error(i18nService.t("Model '{model}' is not available. Please check your API key and model access.").replace('{model}', currentModel))
          }
        }
      }

      throw new Error(`${i18nService.t('Failed to get response from Gemini')}: ${errorMessage}`)
    }
  }

  public async sendMessageStream(message: string, context?: string, history: Array<{role: string, content: string}> = []): Promise<AsyncGenerator<string>> {
    if (!this.isConfigured()) {
      throw new Error(i18nService.t('Gemini API key not configured. Please set your API key in settings.'))
    }

    this.initialize()

    const model = this.getModel()
    if (!model) {
      throw new Error(i18nService.t('Failed to initialize Gemini model'))
    }

    try {
      let prompt = message
      if (context) {
        prompt = `Context:\n${context}\n\nUser message:\n${message}`
      }
      
      // Host-app identity so the model answers for THIS editor, not VS Code
      prompt += APP_CONTEXT_PROMPT

      // Add instruction for file operations using simple commands
      prompt += AGENT_INSTRUCTIONS

      // Build conversation history for Gemini
      const contents = []

      // Add history if provided
      if (history.length > 0) {
        for (const msg of history) {
          if (msg.role === 'user') {
            contents.push({ role: 'user', parts: [{ text: msg.content }] })
          } else if (msg.role === 'assistant') {
            contents.push({ role: 'model', parts: [{ text: msg.content }] })
          }
        }
      }

      // Add current message
      contents.push({ role: 'user', parts: [{ text: prompt }] })

      const result = await this.withTimeout(model.generateContentStream({ contents }), this.timeout) as any
      
      async function* streamGenerator() {
        let tokenCount = 0
        for await (const chunk of result.stream) {
          const chunkText = chunk.text()
          if (chunkText) {
            tokenCount += chunkText.length
            // Additional safety check for token limit
            if (tokenCount > 10000) { // Hard limit as safety
              throw new Error(i18nService.t('Response too long. Try with a more specific prompt.'))
            }
            yield chunkText
          }
        }
      }

      return streamGenerator()
    } catch (error) {
      console.error('Gemini API error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      const managedError = this.describeManagedError(errorMessage)
      if (managedError) throw new Error(managedError)

      // Check if it's a timeout error
      if (errorMessage.includes('timeout')) {
        throw new Error(i18nService.t('Request timed out. The AI response took too long. Try with a simpler prompt or check your internet connection.'))
      }

      // Check if it's a model not found error and try fallback.
      // Skipped in managed mode: the organization controls the model list,
      // and the fallback must not rewrite the personal model setting.
      if (!configService.getManagedCredentials() && (errorMessage.includes('not found') || errorMessage.includes('is not supported'))) {
        const currentModel = this.getModelName()
        console.log(`Model '${currentModel}' not available for streaming, trying fallback...`)
        localStorage.setItem('gemini_model', 'gemini-1.5-flash') // Try fallback
        this.initialize()
        const fallbackModel = this.getModel()
        if (fallbackModel) {
          try {
            const result = await this.withTimeout(fallbackModel.generateContentStream(prompt), this.timeout) as any

            async function* fallbackStreamGenerator() {
              let tokenCount = 0
              for await (const chunk of result.stream) {
                const chunkText = chunk.text()
                if (chunkText) {
                  tokenCount += chunkText.length
                  if (tokenCount > 10000) {
                    throw new Error(i18nService.t('Response too long. Try with a more specific prompt.'))
                  }
                  yield chunkText
                }
              }
            }

            return fallbackStreamGenerator()
          } catch (fallbackError) {
            // Restore original model setting
            localStorage.setItem('gemini_model', currentModel)
            throw new Error(i18nService.t("Model '{model}' is not available for streaming. Please check your API key and model access.").replace('{model}', currentModel))
          }
        }
      }

      throw new Error(`${i18nService.t('Failed to get streaming response from Gemini')}: ${errorMessage}`)
    }
  }
}

export const geminiService = new GeminiService()
