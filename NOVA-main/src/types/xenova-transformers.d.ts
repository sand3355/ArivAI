/**
 * Type declarations for @xenova/transformers
 * 
 * This provides minimal type definitions for the parts of the library we use.
 * @see https://huggingface.co/docs/transformers.js
 */

declare module '@xenova/transformers' {
    /**
     * Environment configuration for transformers.js
     */
    export const env: {
        /** Directory to cache downloaded models */
        cacheDir: string;
        /** Whether to allow downloading models from remote */
        allowRemoteModels: boolean;
        /** Whether to allow local models only */
        allowLocalModels?: boolean;
        /** Use browser cache */
        useBrowserCache?: boolean;
        /** Backend to use (wasm, webgl, webgpu) */
        backends?: {
            onnx?: {
                wasm?: {
                    wasmPaths?: string;
                };
            };
        };
    };

    /**
     * Pipeline type for different model tasks
     */
    export type PipelineType =
        | 'feature-extraction'
        | 'text-classification'
        | 'token-classification'
        | 'question-answering'
        | 'fill-mask'
        | 'summarization'
        | 'translation'
        | 'text-generation'
        | 'text2text-generation'
        | 'zero-shot-classification'
        | 'sentence-similarity'
        | 'image-classification'
        | 'image-segmentation'
        | 'object-detection'
        | 'audio-classification'
        | 'automatic-speech-recognition';

    /**
     * Options for creating a pipeline
     */
    export interface PipelineOptions {
        /** Whether to use quantized model (smaller, faster) */
        quantized?: boolean;
        /** Revision/version of the model */
        revision?: string;
        /** Progress callback */
        progress_callback?: (progress: {
            status: string;
            name?: string;
            file?: string;
            progress?: number;
            loaded?: number;
            total?: number;
        }) => void;
    }

    /**
     * Feature extraction pipeline options
     */
    export interface FeatureExtractionOptions {
        /** Pooling strategy: 'none', 'mean', 'cls' */
        pooling?: 'none' | 'mean' | 'cls';
        /** Whether to normalize the output vectors */
        normalize?: boolean;
    }

    /**
     * Output tensor from the pipeline
     */
    export interface Tensor {
        /** The data array */
        data: Float32Array | number[];
        /** Shape of the tensor */
        dims: number[];
        /** Size of the tensor */
        size: number;
        /** Type of the tensor data */
        type: string;
    }

    /**
     * Pipeline callable interface
     */
    export interface Pipeline {
        /**
         * Process input through the pipeline
         * @param text Input text or array of texts
         * @param options Pipeline options
         * @returns Output tensor or array of tensors
         */
        (text: string | string[], options?: FeatureExtractionOptions): Promise<Tensor>;

        /** Model being used */
        model: unknown;
        /** Tokenizer being used */
        tokenizer: unknown;
    }

    /**
     * Create a pipeline for a specific task
     * @param task The task type
     * @param model The model name/path (e.g., 'Xenova/all-MiniLM-L6-v2')
     * @param options Pipeline options
     * @returns The created pipeline
     */
    export function pipeline(
        task: PipelineType,
        model?: string,
        options?: PipelineOptions
    ): Promise<Pipeline>;

    /**
     * AutoTokenizer for loading tokenizers
     */
    export class AutoTokenizer {
        static from_pretrained(
            model: string,
            options?: { progress_callback?: (progress: unknown) => void }
        ): Promise<unknown>;
    }

    /**
     * AutoModel for loading models
     */
    export class AutoModel {
        static from_pretrained(
            model: string,
            options?: {
                quantized?: boolean;
                progress_callback?: (progress: unknown) => void;
            }
        ): Promise<unknown>;
    }
}
