import { BadRequestException, type PipeTransform } from "@nestjs/common";
import { z } from "zod";

/** Valida o corpo da requisição com um schema de @dishdesk/shared. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({ message: "Dados inválidos", issues: z.flattenError(result.error).fieldErrors });
    }
    return result.data;
  }
}
