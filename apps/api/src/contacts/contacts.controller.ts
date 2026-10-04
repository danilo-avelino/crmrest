import { type ContactDetail, UpdateContactRequest } from "@comanda/shared";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ContactsService } from "./contacts.service.js";

@Controller("contacts")
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<ContactDetail> {
    return this.contacts.get(auth, id);
  }

  @Patch(":id")
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UpdateContactRequest)) body: UpdateContactRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<ContactDetail> {
    return this.contacts.update(auth, id, body);
  }

  @Post(":id/cpf")
  @HttpCode(200)
  revealCpf(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth) {
    return this.contacts.revealCpf(auth, id);
  }
}
