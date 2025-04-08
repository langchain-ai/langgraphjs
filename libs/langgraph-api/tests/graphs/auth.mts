import { Auth } from "@langchain/langgraph-sdk/auth";

export const auth = new Auth()
  .authenticate((request) => {
    const authorization = request.headers.get("Authorization");
    if (!authorization) return { user: null };
    const token = authorization.split(" ")[1];
    if (!token) return { user: null };

    return { user: { id: token } };
  })
  .on("*:create", (data) => {
    console.log(data);
  });
